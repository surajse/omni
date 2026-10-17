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

export interface AgentDeps {
  provider: ModelProvider;
  gateway: ToolGateway;
  policy: PolicyEngine;
  approve: ApprovalHandler;
  memory?: AgentMemory;
  onEvent?: (event: RunEvent) => void;
}

export class Agent {
  constructor(
    private readonly config: AgentConfig,
    private readonly deps: AgentDeps,
  ) {}

  private emit(event: RunEvent): void {
    this.deps.onEvent?.(event);
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: ToolResult = { call, output: '', error: message };
      this.emit({ type: 'tool-result', result });
      messages.push({ role: 'tool', toolCallId: call.id, content: `ERROR: ${message}` });
    }
  }
}
