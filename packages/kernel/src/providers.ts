// Model providers: the kernel's only interface to an LLM.
import type { ChatMessage, ToolCall, ToolDefinition } from './types.js';

export interface ModelProvider {
  name: string;
  complete(req: {
    messages: ChatMessage[];
    tools: ToolDefinition[];
  }): Promise<{ text: string; toolCalls: ToolCall[] }>;
}

// --- OpenAI wire-format helpers (used only inside OpenAICompatibleProvider) ---

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

function toWireMessage(m: ChatMessage): WireMessage {
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
  }
  const wire: WireMessage = { role: m.role, content: m.content };
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    wire.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    }));
  }
  return wire;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return { _raw: raw };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts: { baseUrl: string; apiKey: string; model: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
  }

  async complete(req: {
    messages: ChatMessage[];
    tools: ToolDefinition[];
  }): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const body = {
      model: this.model,
      messages: req.messages.map(toWireMessage),
      tools: req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The key is only ever sent as an Authorization header; it is never logged.
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `OpenAI-compatible request to ${this.baseUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `OpenAI-compatible request failed with HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
      );
    }
    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: WireToolCall[] };
      }>;
    };
    const message = data.choices?.[0]?.message;
    if (!message) {
      throw new Error('OpenAI-compatible response contained no choices[0].message');
    }
    return {
      text: message.content ?? '',
      toolCalls: (message.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: parseArgs(tc.function.arguments),
      })),
    };
  }
}

/** Deterministic scripted provider for tests and offline demos. */
export class MockProvider implements ModelProvider {
  readonly name = 'mock';
  private readonly queue: Array<{ text?: string; toolCalls?: ToolCall[] }>;

  constructor(script: Array<{ text?: string; toolCalls?: ToolCall[] }>) {
    this.queue = [...script];
  }

  async complete(): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const next = this.queue.shift();
    if (!next) {
      throw new Error('MockProvider: script exhausted (no more scripted replies)');
    }
    return { text: next.text ?? '', toolCalls: next.toolCalls ?? [] };
  }
}
