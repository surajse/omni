import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../src/agent.js';
import { MockProvider, type ModelProvider } from '../src/providers.js';
import { PolicyEngine } from '../src/policy.js';
import { ToolGateway } from '../src/tools.js';
import type {
  AgentConfig,
  ChatMessage,
  RunEvent,
  ToolCall,
  ToolDefinition,
} from '../src/types.js';

const baseConfig: AgentConfig = {
  id: 'test-agent',
  name: 'Test Agent',
  model: { provider: 'mock', model: 'mock' },
  systemPrompt: 'You are a test agent.',
  tools: [],
  policy: [],
  memoryNamespace: 'test',
};

function makeGateway() {
  const gateway = new ToolGateway();
  const getTime = vi.fn(() => '2026-01-01T00:00:00.000Z');
  const writeFile = vi.fn((_args: Record<string, unknown>) => 'written');
  gateway.register(
    {
      name: 'get_time',
      description: 'read the clock',
      parameters: { type: 'object' },
      readOnly: true,
    },
    getTime,
  );
  gateway.register(
    {
      name: 'write_file',
      description: 'write a file',
      parameters: { type: 'object' },
      readOnly: false,
    },
    writeFile,
  );
  return { gateway, getTime, writeFile };
}

/** Scripted provider that records every messages array it receives. */
class RecordingProvider implements ModelProvider {
  readonly name = 'mock-recording';
  readonly seen: ChatMessage[][] = [];
  readonly toolsSeen: ToolDefinition[][] = [];
  private readonly queue: Array<{ text?: string; toolCalls?: ToolCall[] }>;

  constructor(script: Array<{ text?: string; toolCalls?: ToolCall[] }>) {
    this.queue = [...script];
  }

  async complete(req: {
    messages: ChatMessage[];
    tools: ToolDefinition[];
  }): Promise<{ text: string; toolCalls: ToolCall[] }> {
    this.seen.push(req.messages);
    this.toolsSeen.push(req.tools);
    const next = this.queue.shift();
    if (!next) throw new Error('RecordingProvider: script exhausted');
    return { text: next.text ?? '', toolCalls: next.toolCalls ?? [] };
  }
}

describe('Agent', () => {
  it('executes a read tool and returns final text containing the tool output', async () => {
    const { gateway, getTime } = makeGateway();
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'get_time', arguments: {} }] },
      { text: 'The time is 2026-01-01T00:00:00.000Z.' },
    ]);
    const events: RunEvent[] = [];
    const agent = new Agent(baseConfig, {
      provider,
      gateway,
      policy: new PolicyEngine([]),
      approve: () => Promise.resolve(true),
      onEvent: (e) => events.push(e),
    });

    const result = await agent.run('what time is it?');

    expect(getTime).toHaveBeenCalledTimes(1);
    expect(result).toContain('2026-01-01T00:00:00.000Z');
    expect(events.map((e) => e.type)).toContain('tool-call');
    expect(events.map((e) => e.type)).toContain('tool-result');
    expect(events.at(-1)).toEqual({ type: 'done', output: result });
  });

  it('skips a write tool when approval is declined and records SKIPPED in the transcript', async () => {
    const { gateway, writeFile } = makeGateway();
    const provider = new RecordingProvider([
      { toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: 'x.txt' } }] },
      { text: 'done' },
    ]);
    const events: RunEvent[] = [];
    const agent = new Agent(baseConfig, {
      provider,
      gateway,
      policy: new PolicyEngine([]), // default: write -> ask
      approve: () => Promise.resolve(false),
      onEvent: (e) => events.push(e),
    });

    const result = await agent.run('write a file');

    expect(writeFile).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: 'approval',
      call: { id: 'c1', name: 'write_file', arguments: { path: 'x.txt' } },
      decision: 'skipped',
    });
    const lastMessages = provider.seen.at(-1) ?? [];
    const toolMsg = lastMessages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('SKIPPED (not approved)');
    expect(result).toBe('done');
  });

  it('denies a tool matched by a deny rule and records DENIED in the transcript', async () => {
    const { gateway, writeFile } = makeGateway();
    const provider = new RecordingProvider([
      { toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: 'x.txt' } }] },
      { text: 'cannot do that' },
    ]);
    const events: RunEvent[] = [];
    const approve = vi.fn(() => Promise.resolve(true));
    const agent = new Agent(baseConfig, {
      provider,
      gateway,
      policy: new PolicyEngine([{ match: 'write_*', effect: 'deny' }]),
      approve,
      onEvent: (e) => events.push(e),
    });

    await agent.run('write a file');

    expect(writeFile).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: 'approval',
      call: { id: 'c1', name: 'write_file', arguments: { path: 'x.txt' } },
      decision: 'denied',
    });
    const lastMessages = provider.seen.at(-1) ?? [];
    const toolMsg = lastMessages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('DENIED by policy');
  });

  it('returns a stopped note when maxSteps is reached', async () => {
    const { gateway } = makeGateway();
    const provider = new MockProvider([
      { toolCalls: [{ id: 'c1', name: 'get_time', arguments: {} }] },
      { toolCalls: [{ id: 'c2', name: 'get_time', arguments: {} }] },
    ]);
    const agent = new Agent(baseConfig, {
      provider,
      gateway,
      policy: new PolicyEngine([]),
      approve: () => Promise.resolve(true),
    });

    const result = await agent.run('loop forever', { maxSteps: 1 });
    expect(result).toContain('Stopped after 1 steps');
  });

  it('includes memory summary in the system messages when memory is provided', async () => {
    const { gateway } = makeGateway();
    const provider = new RecordingProvider([{ text: 'hi' }]);
    const agent = new Agent(baseConfig, {
      provider,
      gateway,
      policy: new PolicyEngine([]),
      approve: () => Promise.resolve(true),
      memory: {
        recall: (namespace: string) => [
          { key: 'user', value: 'Suraj', updatedAt: '2026-01-01T00:00:00.000Z' },
        ],
      },
    });

    await agent.run('hello');
    const firstMessages = provider.seen[0];
    expect(firstMessages[0]).toMatchObject({ role: 'system', content: 'You are a test agent.' });
    expect(firstMessages[1]?.content).toContain('Suraj');
    void gateway;
  });
});
