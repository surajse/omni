import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/registry.js';
import type { AgentConfig } from '../src/types.js';
import { MockProvider } from '../src/providers.js';
import { PolicyEngine } from '../src/policy.js';
import { ToolGateway } from '../src/tools.js';
import {
  findMentions,
  GroupStore,
  runGroupTurn,
  type GroupTurnDeps,
} from '../src/group.js';

function makeConfig(id: string): AgentConfig {
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

/** Deps factory: each member gets a MockProvider whose single reply is scripted. */
function makeDepsFactory(scripts: Record<string, string>): GroupTurnDeps['makeDeps'] {
  return (config: AgentConfig) => ({
    config,
    deps: {
      provider: new MockProvider([{ text: scripts[config.id] ?? `reply from ${config.id}` }]),
      gateway: new ToolGateway(),
      policy: new PolicyEngine([]),
      approve: async () => true,
    },
  });
}

function setupGroup(members: string[]): { store: GroupStore; registry: AgentRegistry; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'omni-group-'));
  const registry = new AgentRegistry(join(home, 'agents'));
  for (const id of members) registry.create(makeConfig(id));
  const store = new GroupStore(home);
  return { store, registry, home };
}

describe('GroupStore', () => {
  it('creates, lists, gets, removes groups', () => {
    const { store } = setupGroup(['a', 'b']);
    expect(store.list()).toEqual([]);
    const s = store.create('team1', ['a', 'b']);
    expect(s.members).toEqual(['a', 'b']);
    expect(s.maxRounds).toBe(6);
    expect(store.list().map((g) => g.name)).toEqual(['team1']);
    expect(store.get('team1').name).toBe('team1');
    store.remove('team1');
    expect(store.list()).toEqual([]);
  });

  it('validates input', () => {
    const { store } = setupGroup(['a', 'b']);
    expect(() => store.create('x', ['a'])).toThrow(/at least 2 members/);
    expect(() => store.create('x', ['a', 'a'])).toThrow(/unique/);
    expect(() => store.create('Bad Name', ['a', 'b'])).toThrow(/invalid group name/);
    expect(() => store.get('nope')).toThrow(/unknown group/);
  });

  it('persists history in order', () => {
    const { store } = setupGroup(['a', 'b']);
    store.create('g', ['a', 'b']);
    expect(store.history('g')).toEqual([]);
    store.appendHistory('g', { role: 'user', content: 'hi', at: 't1' });
    store.appendHistory('g', { role: 'a', content: 'yo', at: 't2' });
    const h = store.history('g');
    expect(h.map((m) => `${m.role}:${m.content}`)).toEqual(['user:hi', 'a:yo']);
  });
});

describe('findMentions', () => {
  it('finds @member mentions', () => {
    expect(findMentions('hey @bob what do you think?', ['alice', 'bob'])).toEqual(['bob']);
    expect(findMentions('no mentions here', ['alice'])).toEqual([]);
    expect(findMentions('@alice and @bob', ['alice', 'bob'])).toEqual(['alice', 'bob']);
  });
});

describe('runGroupTurn', () => {
  it('alternates members round-robin with labeled turns', async () => {
    const { store, registry } = setupGroup(['scout', 'writer']);
    const session = store.create('room', ['scout', 'writer'], 4);
    const deps: GroupTurnDeps = {
      getConfig: (id) => registry.get(id),
      makeDeps: makeDepsFactory({ scout: 'found 3 links', writer: 'drafted the post' }),
    };
    const turns = await runGroupTurn(store, session, 'research this topic', deps);
    expect(turns.map((t) => t.member)).toEqual(['scout', 'writer', 'scout', 'writer']);
    expect(turns[0]!.output).toBe('found 3 links');
    expect(turns[1]!.output).toBe('drafted the post');
    const history = store.history('room');
    expect(history[0]).toMatchObject({ role: 'user', content: 'research this topic' });
    expect(history.map((m) => m.role)).toEqual(['user', 'scout', 'writer', 'scout', 'writer']);
  });

  it('@mention routes the next turn to that member', async () => {
    const { store, registry } = setupGroup(['scout', 'writer']);
    const session = store.create('room', ['scout', 'writer'], 3);
    const deps: GroupTurnDeps = {
      getConfig: (id) => registry.get(id),
      makeDeps: makeDepsFactory({ scout: 'over to @writer for the draft', writer: 'here is the draft' }),
    };
    const turns = await runGroupTurn(store, session, 'go', deps);
    // scout first (round-robin start), then @writer mention routes to writer
    expect(turns[0]!.member).toBe('scout');
    expect(turns[1]!.member).toBe('writer');
  });

  it('stops early on /done and respects maxRounds', async () => {
    const { store, registry } = setupGroup(['a', 'b']);
    const session = store.create('room', ['a', 'b'], 10);
    const deps: GroupTurnDeps = {
      getConfig: (id) => registry.get(id),
      makeDeps: makeDepsFactory({ a: 'all good /done', b: 'never speaks' }),
    };
    const turns = await runGroupTurn(store, session, 'go', deps);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.member).toBe('a');
  });

  it('caps turns at maxRounds', async () => {
    const { store, registry } = setupGroup(['a', 'b']);
    const session = store.create('room', ['a', 'b'], 2);
    const deps: GroupTurnDeps = {
      getConfig: (id) => registry.get(id),
      makeDeps: makeDepsFactory({}),
    };
    const turns = await runGroupTurn(store, session, 'go', deps);
    expect(turns).toHaveLength(2);
  });
});
