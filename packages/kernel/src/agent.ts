// The agent loop: model -> tool calls (policy-gated) -> model -> final text.
import type {
  AgentConfig,
  ChatMessage,
  RunEvent,
  ToolCall,
  ToolResult,
} from './types.js';
import type { ModelProvider } from './providers.js';
import type { ToolGateway } from './tools.js';
import type { ApprovalHandler, PolicyEngine } from './policy.js';

/** Minimal structural memory interface; the kernel never depends on @omni/memory. */
export interface AgentMemory {
  recall(
    namespace: string,
    key?: string,
  ): Array<{ key: string; value: string; updatedAt: string }>;
}

/**
 * Structural interface for vector-capable memory (implemented by
 * SqliteMemoryStore). Detected at runtime so the kernel keeps zero
 * dependency on @omni/memory.
 */
export interface AgentVectorMemory {
  rememberVec(namespace: string, key: string, value: string, embedding: number[]): void;
  semanticRecall(
    namespace: string,
    queryEmbedding: number[],
    k?: number,
  ): Array<{ key: string; value: string; score: number }>;
}

export interface AgentDeps {
  provider: ModelProvider;
  gateway: ToolGateway;
  policy: PolicyEngine;
  approve: ApprovalHandler;
  memory?: AgentMemory;
  onEvent?: (event: RunEvent) => void;
  /**
   * Optional embedder. When present (and memory is vector-capable), the agent
   * injects top-k semantic recall into context and stores tool-result
   * summaries as vectors. Best-effort: embedding failures never break a run.
   */
  embedder?: (texts: string[]) => Promise<number[][]>;
}

export class Agent {
  constructor(
    private readonly config: AgentConfig,
    private readonly deps: AgentDeps,
  ) {}

  private emit(event: RunEvent): void {
    this.deps.onEvent?.(event);
  }

  /** The attached memory if it supports vector operations, else null. */
  private vectorMemory(): AgentVectorMemory | null {
    const m = this.deps.memory as Partial<AgentVectorMemory> | undefined;
    if (!m || typeof m.semanticRecall !== 'function' || typeof m.rememberVec !== 'function') {
      return null;
    }
    return m as AgentVectorMemory;
  }

  async run(task: string, opts: { maxSteps?: number } = {}): Promise<string> {
    const maxSteps = opts.maxSteps ?? 12;
    const messages: ChatMessage[] = [{ role: 'system', content: this.config.systemPrompt }];

    if (this.deps.memory) {
      const entries = this.deps.memory.recall(this.config.memoryNamespace);
      if (entries.length > 0) {
        messages.push({
          role: 'system',
          content:
            'Relevant memories:\n' + entries.map((e) => `- ${e.key}: ${e.value}`).join('\n'),
        });
      }
      await this.injectSemanticRecall(task, messages);
    }
    messages.push({ role: 'user', content: task });

    const tools =
      this.config.tools.length === 0
        ? this.deps.gateway.list()
        : this.deps.gateway.list().filter((d) => this.config.tools.includes(d.name));

    let lastText = '';
    for (let step = 0; step < maxSteps; step++) {
      const { text, toolCalls } = await this.deps.provider.complete({ messages, tools });

      if (text) {
        this.emit({ type: 'text', text });
        lastText = text;
      }
      messages.push({
        role: 'assistant',
        content: text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });

      if (toolCalls.length === 0) {
        this.emit({ type: 'done', output: lastText });
        return lastText;
      }

      for (const call of toolCalls) {
        this.emit({ type: 'tool-call', call });
        await this.handleToolCall(call, messages);
      }
    }

    const output = `${lastText}\n[Stopped after ${maxSteps} steps without a final answer.]`;
    this.emit({ type: 'done', output });
    return output;
  }

  private async handleToolCall(call: ToolCall, messages: ChatMessage[]): Promise<void> {
    const def = this.deps.gateway.list().find((d) => d.name === call.name);
    const decision = this.deps.policy.decide(call.name, def?.readOnly ?? false);

    if (decision === 'deny') {
      this.emit({ type: 'approval', call, decision: 'denied' });
      messages.push({ role: 'tool', toolCallId: call.id, content: 'DENIED by policy' });
      return;
    }

    if (decision === 'ask') {
      const approved = await this.deps.approve({ tool: call.name, args: call.arguments });
      this.emit({ type: 'approval', call, decision: approved ? 'approved' : 'skipped' });
      if (!approved) {
        messages.push({ role: 'tool', toolCallId: call.id, content: 'SKIPPED (not approved)' });
        return;
      }
    }

    try {
      const output = await this.deps.gateway.execute(call.name, call.arguments);
      const result: ToolResult = { call, output };
      this.emit({ type: 'tool-result', result });
      messages.push({ role: 'tool', toolCallId: call.id, content: output });
      await this.rememberToolVector(call, output);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: ToolResult = { call, output: '', error: message };
      this.emit({ type: 'tool-result', result });
      messages.push({ role: 'tool', toolCallId: call.id, content: `ERROR: ${message}` });
    }
  }

  /**
   * Inject top-k semantic recall for the task. Best-effort: embedding
   * failures are swallowed so they can never break a run.
   */
  private async injectSemanticRecall(task: string, messages: ChatMessage[]): Promise<void> {
    const vecMem = this.vectorMemory();
    if (!this.deps.embedder || !vecMem) return;
    try {
      const [query] = await this.deps.embedder([task]);
      if (!query) return;
      const hits = vecMem.semanticRecall(this.config.memoryNamespace, query, 5);
      if (hits.length === 0) return;
      messages.push({
        role: 'system',
        content:
          'Semantically relevant memories:\n' +
          hits.map((h) => `- ${h.key}: ${h.value} (relevance ${h.score.toFixed(2)})`).join('\n'),
      });
    } catch {
      /* embedding is best-effort; ignore failures */
    }
  }

  /** Store a tool result summary as a vector for future semantic recall. */
  private async rememberToolVector(call: ToolCall, output: string): Promise<void> {
    const vecMem = this.vectorMemory();
    if (!this.deps.embedder || !vecMem) return;
    try {
      const summary = `Tool ${call.name} returned: ${output.slice(0, 500)}`;
      const [emb] = await this.deps.embedder([summary]);
      if (!emb) return;
      vecMem.rememberVec(this.config.memoryNamespace, `vec:${call.id}`, summary, emb);
    } catch {
      /* embedding is best-effort; ignore failures */
    }
  }
}
