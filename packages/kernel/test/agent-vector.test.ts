import { describe, expect, it, vi } from 'vitest';
import { Agent, type AgentVectorMemory } from '../src/agent.js';
import { MockProvider, type ModelProvider } from '../src/providers.js';
import { PolicyEngine } from '../src/policy.js';
import { ToolGateway } from '../src/tools.js';
import type { AgentConfig, ChatMessage, ToolCall, ToolDefinition } from '../src/types.js';

/** Scripted provider that records every messages array it receives. */
class RecordingProvider implements ModelProvider {
  readonly name = 'mock-recording';
  readonly seen: ChatMessage[][] = [];
  private readonly queue: Array<{ text?: string; toolCalls?: ToolCall[] }>;
  constructor(script: Array<{ text?: string; toolCalls?: ToolCall[] }>) {
    this.queue = [...script];
  }
  async complete(req: {
    messages: ChatMessage[];
    tools: ToolDefinition[];
  }): Promise<{ text: string; toolCalls: ToolCall[] }> {
    this.seen.push(req.messages);
    const next = this.queue.shift();
    if (!next) throw new Error('RecordingProvider: script exhausted');
    return { text: next.text ?? '', toolCalls: next.toolCalls ?? [] };
  }
}

/** In-memory AgentVectorMemory (no @omni/memory dependency in kernel tests). */
class FakeVectorMemory implements AgentVectorMemory {
  private readonly rows = new Map<string, { value: string; emb: number[] }>();
  recall(): Array<{ key: string; value: string; updatedAt: string }> {
    return [];
  }
  rememberVec(_ns: string, key: string, value: string, embedding: number[]): void {
    this.rows.set(key, { value, emb: embedding });
  }
  semanticRecall(_ns: string, q: number[], k = 5): Array<{ key: string; value: string; score: number }> {
    const cos = (a: number[], b: number[]) => {
      const dot = a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
      return dot / (Math.sqrt(a.reduce((s, x) => s + x * x, 0)) * Math.sqrt(b.reduce((s, x) => s + x * x, 0)));
    };
    return [...this.rows.entries()]
      .map(([key, r]) => ({ key, value: r.value, score: cos(q, r.emb) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
  keys(): string[] {
    return [...this.rows.keys()];
  }
}

const baseConfig: AgentConfig = {
  id: 'vec-agent',
  name: 'Vec',
  model: { provider: 'mock', model: 'mock' },
  systemPrompt: 'You are a test agent.',
  tools: [],
  policy: [],
  memoryNamespace: 'vec',
};

/** Deterministic fake embedder: alpha→[1,0], beta→[0,1], else [0.5,0.5]. */
const fakeEmbedder = async (texts: string[]): Promise<number[][]> =>
  texts.map((t) => (t.includes('alpha') ? [1, 0] : t.includes('beta') ? [0, 1] : [0.5, 0.5]));

function gatewayWithTime() {
  const gateway = new ToolGateway();
  gateway.register(
    { name: 'get_time', description: 'clock', parameters: { type: 'object' }, readOnly: true },
    vi.fn(() => 'noon'),
  );
  return gateway;
}

describe('Agent vector memory', () => {
  it('injects semantic recall into context', async () => {
    const memory = new FakeVectorMemory();
    memory.rememberVec('vec', 'alpha-key', 'alpha content here', [1, 0]);
    const provider = new RecordingProvider([{ text: 'done' }]);
    const agent = new Agent(baseConfig, {
      provider,
      gateway: gatewayWithTime(),
      policy: new PolicyEngine([]),
      approve: () => Promise.resolve(true),
      memory,
      embedder: fakeEmbedder,
    });
    await agent.run('tell me about alpha');
    const systemTexts = provider.seen[0]!
      .filter((m) => m.role === 'system')
      .map((m) => m.content);
    const semantic = systemTexts.find((t) => t.includes('Semantically relevant memories'));
    expect(semantic).toBeDefined();
    expect(semantic).toContain('alpha content here');
  });

  it('stores tool-result summaries as vectors', async () => {
    const memory = new FakeVectorMemory();
    const provider = new RecordingProvider([
      { toolCalls: [{ id: 'c1', name: 'get_time', arguments: {} }] },
      { text: 'done' },
    ]);
    const agent = new Agent(baseConfig, {
      provider,
      gateway: gatewayWithTime(),
      policy: new PolicyEngine([]),
      approve: () => Promise.resolve(true),
      memory,
      embedder: fakeEmbedder,
    });
    await agent.run('what time is it');
    expect(memory.keys()).toContain('vec:c1');
  });

  it('works fine without an embedder (existing behavior)', async () => {
    const provider = new RecordingProvider([{ text: 'done' }]);
    const agent = new Agent(baseConfig, {
      provider,
      gateway: gatewayWithTime(),
      policy: new PolicyEngine([]),
      approve: () => Promise.resolve(true),
      memory: new FakeVectorMemory(),
    });
    expect(await agent.run('hi')).toBe('done');
    const systemTexts = provider.seen[0]!.filter((m) => m.role === 'system').map((m) => m.content);
    expect(systemTexts.some((t) => t.includes('Semantically relevant'))).toBe(false);
  });

  it('survives embedder failures', async () => {
    const provider = new RecordingProvider([{ text: 'done' }]);
    const agent = new Agent(baseConfig, {
      provider,
      gateway: gatewayWithTime(),
      policy: new PolicyEngine([]),
      approve: () => Promise.resolve(true),
      memory: new FakeVectorMemory(),
      embedder: async () => {
        throw new Error('embeddings down');
      },
    });
    expect(await agent.run('hi')).toBe('done');
  });

  it('uses plain MockProvider without embedder like before', async () => {
    const provider = new MockProvider([{ text: 'ok' }]);
    const agent = new Agent(baseConfig, {
      provider,
      gateway: gatewayWithTime(),
      policy: new PolicyEngine([]),
      approve: () => Promise.resolve(true),
    });
    expect(await agent.run('hi')).toBe('ok');
  });
});
