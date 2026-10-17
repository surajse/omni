import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/registry.js';
import type { AgentConfig } from '../src/types.js';

function config(id: string): AgentConfig {
  return {
    id,
    name: `Agent ${id}`,
    model: { provider: 'mock', model: 'mock' },
    systemPrompt: 'hi',
    tools: [],
    policy: [],
    memoryNamespace: id,
  };
}

function freshRegistry(): AgentRegistry {
  return new AgentRegistry(mkdtempSync(join(tmpdir(), 'omni-registry-')));
}

describe('AgentRegistry', () => {
  it('create/get/list/remove roundtrip', () => {
    const registry = freshRegistry();
    registry.create(config('alpha'));
    registry.create(config('beta'));

    expect(registry.get('alpha').name).toBe('Agent alpha');
    expect(registry.list().map((a) => a.id).sort()).toEqual(['alpha', 'beta']);

    registry.remove('alpha');
    expect(registry.list().map((a) => a.id)).toEqual(['beta']);
    expect(() => registry.get('alpha')).toThrow(/Unknown agent/);
  });

  it('rejects invalid ids', () => {
    const registry = freshRegistry();
    expect(() => registry.create(config('Bad Id!'))).toThrow(/Invalid agent id/);
    expect(() => registry.create(config('UPPER'))).toThrow(/Invalid agent id/);
  });

  it('rejects duplicate ids and removing unknown ids', () => {
    const registry = freshRegistry();
    registry.create(config('alpha'));
    expect(() => registry.create(config('alpha'))).toThrow(/already exists/);
    expect(() => registry.remove('nope')).toThrow(/Unknown agent/);
  });
});
