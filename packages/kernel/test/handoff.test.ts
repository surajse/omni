import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Agent,
  AgentRegistry,
  MockProvider,
  PolicyEngine,
  ToolGateway,
  createHandoffTool,
  registerHandoffTool,
  type AgentConfig,
  type AgentDeps,
  type RunEvent,
  type ToolCall,
} from '../src/index.js';

function configFor(id: string): AgentConfig {
  return {
    id,
    name: id,
    model: { provider: 'mock', model: 'mock' },
    systemPrompt: `You are ${id}.`,
    tools: [],
    policy: [],
    memoryNamespace: id,
  };
}

function handoffCall(to: string): ToolCall {
  return { id: `call-${to}`, name: 'agent.handoff', arguments: { to_agent: to, task: `task for ${to}` } };
}

interface Harness {
  registry: AgentRegistry;
  constructed: string[];
  events: RunEvent[];
  scripts: Map<string, Array<{ text?: string; toolCalls?: ToolCall[] }>>;
  makeDeps: (config: AgentConfig) => AgentDeps;
}

function harness(ids: string[], opts: { maxDepth?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'omni-handoff-test-'));
  const registry = new AgentRegistry(dir);
  for (const id of ids) registry.create(configFor(id));
  const constructed: string[] = [];
  const events: RunEvent[] = [];
  const scripts = new Map<string, Array<{ text?: string; toolCalls?: ToolCall[] }>>();
  const h: Harness = {
    registry,
    constructed,
    events,
    scripts,
    makeDeps: (config: AgentConfig): AgentDeps => {
      constructed.push(config.id);
      return {
        provider: new MockProvider(scripts.get(config.id) ?? []),
        gateway: new ToolGateway(),
        policy: new PolicyEngine([]),
        approve: async () => true,
        onEvent: (e) => events.push(e),
      };
    },
  };
  void opts;
  return h;
}

function topGateway(h: Harness, maxDepth?: number): ToolGateway {
  const gateway = new ToolGateway();
  registerHandoffTool(gateway, { registry: h.registry, makeDeps: h.makeDeps, maxDepth });
  return gateway;
}

function topAgent(h: Harness, id: string, maxDepth?: number): Agent {
  const config = h.registry.get(id);
  return new Agent(config, {
    provider: new MockProvider(h.scripts.get(id) ?? []),
    gateway: topGateway(h, maxDepth),
    policy: new PolicyEngine([]),
    approve: async () => true,
    onEvent: (e) => h.events.push(e),
  });
}

describe('agent.handoff', () => {
  it('delegates to another agent and returns its answer', async () => {
    const h = harness(['a', 'b']);
    h.scripts.set('a', [{ toolCalls: [handoffCall('b')] }, { text: 'A done' }]);
    h.scripts.set('b', [{ text: "B's answer" }]);

    const out = await topAgent(h, 'a').run('go');
    expect(out).toBe('A done');
    expect(h.constructed).toEqual(['b']);
    const result = h.events.find(
      (e): e is RunEvent & { type: 'tool-result' } =>
        e.type === 'tool-result' && e.result.call.name === 'agent.handoff',
    );
    expect(result?.result.output).toBe("B's answer");
  });

  it('surfaces an unknown target as a clean error in the transcript', async () => {
    const h = harness(['a']);
    h.scripts.set('a', [{ toolCalls: [handoffCall('ghost')] }, { text: 'A recovered' }]);

    const out = await topAgent(h, 'a').run('go');
    expect(out).toBe('A recovered');
    const result = h.events.find((e) => e.type === 'tool-result');
    expect(result?.type).toBe('tool-result');
    if (result?.type === 'tool-result') {
      expect(result.result.error).toContain('Unknown agent: ghost');
    }
    expect(h.constructed).toEqual([]);
  });

  it('enforces maxDepth across a chain (A→B→C blocked at maxDepth 2)', async () => {
    const h = harness(['a', 'b', 'c', 'd']);
    h.scripts.set('a', [{ toolCalls: [handoffCall('b')] }, { text: 'A done' }]);
    h.scripts.set('b', [{ toolCalls: [handoffCall('c')] }, { text: 'B done' }]);
    h.scripts.set('c', [{ toolCalls: [handoffCall('d')] }, { text: 'C done' }]);
    h.scripts.set('d', [{ text: 'D answer' }]);

    const out = await topAgent(h, 'a', 2).run('go');
    expect(out).toBe('A done');
    // a→b (depth 0) and b→c (depth 1) succeed; c→d hits the depth guard.
    expect(h.constructed).toEqual(['b', 'c']);
    const errors = h.events
      .filter((e) => e.type === 'tool-result')
      .map((e) => ((e as { result: { error?: string } }).result.error ?? ''));
    expect(errors.some((m) => m.includes('handoff depth exceeded'))).toBe(true);
  });

  it('validates to_agent and task arguments', async () => {
    const h = harness(['a']);
    const { handler } = createHandoffTool({ registry: h.registry, makeDeps: h.makeDeps });
    await expect(handler({})).rejects.toThrow('"to_agent"');
    await expect(handler({ to_agent: 'a' })).rejects.toThrow('"task"');
  });

  it('is write-class so policy defaults to ask', async () => {
    const h = harness(['a']);
    const { def } = createHandoffTool({ registry: h.registry, makeDeps: h.makeDeps });
    expect(def.name).toBe('agent.handoff');
    expect(def.readOnly).toBe(false);
    expect(def.parameters).toHaveProperty('properties.to_agent');
  });
});
