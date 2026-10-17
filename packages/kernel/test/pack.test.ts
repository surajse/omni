import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/registry.js';
import { packAgent, removeUnpackedAgent, unpackAgent, type PackMemoryStore } from '../src/pack.js';
import type { AgentConfig } from '../src/types.js';

function stubMemory(): PackMemoryStore & { data: Array<Record<string, string>> } {
  const data: Array<Record<string, string>> = [];
  return {
    data,
    exportJson: (namespace?: string) =>
      JSON.stringify(data.filter((e) => namespace === undefined || e['namespace'] === namespace)),
    importJson: (json: string) => {
      const parsed = JSON.parse(json) as Array<Record<string, string>>;
      for (const e of parsed) data.push(e);
    },
  };
}

function makeConfig(id: string): AgentConfig {
  return {
    id,
    name: `Agent ${id}`,
    model: { provider: 'mock', model: 'mock' },
    systemPrompt: 'Be helpful.',
    tools: [],
    policy: [],
    memoryNamespace: id,
  };
}

function seedAgent(home: string, id: string, memory: PackMemoryStore): void {
  new AgentRegistry(join(home, 'agents')).create(makeConfig(id));
  const dir = join(home, 'agents', id);
  mkdirSync(join(dir, 'skills', 'greet'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'greet', 'SKILL.md'), '# Greet\nSay hi.\n');
  writeFileSync(join(dir, 'skills', 'greet', 'skill.json'), '{"name":"greet"}');
  writeFileSync(
    join(dir, 'routines.json'),
    JSON.stringify([{ id: 'r1', agentId: id, cron: '0 9 * * *', task: 'say hi', enabled: true, createdAt: 'x' }]),
  );
  memory.importJson(
    JSON.stringify([
      { namespace: id, key: 'color', value: 'blue' },
      { namespace: id, key: 'api_key', value: 'should-be-scrubbed' },
    ]),
  );
}

describe('agent packs', () => {
  it('exports and re-imports an agent with skills, routines, and scrubbed memory', () => {
    const home = mkdtempSync(join(tmpdir(), 'omni-pack-'));
    const memory = stubMemory();
    seedAgent(home, 'scout', memory);

    const pack = packAgent(home, 'scout', memory);
    expect(pack.version).toBe(1);
    expect(pack.agent.id).toBe('scout');
    expect(pack.skills).toHaveLength(1);
    expect(pack.skills[0]!.files['SKILL.md']).toContain('# Greet');
    expect(pack.routines).toHaveLength(1);
    expect(pack.routines[0]!.cron).toBe('0 9 * * *');
    // Secrets are scrubbed at export time.
    expect(pack.memoryJson).not.toContain('should-be-scrubbed');
    expect(pack.memoryJson).toContain('[REDACTED]');

    // Import under a new id: config, skills, routines, memory all survive.
    const home2 = mkdtempSync(join(tmpdir(), 'omni-pack2-'));
    const memory2 = stubMemory();
    const config = unpackAgent(home2, pack, memory2, 'scout2');
    expect(config.id).toBe('scout2');
    expect(config.memoryNamespace).toBe('scout2');
    expect(new AgentRegistry(join(home2, 'agents')).get('scout2').name).toBe('Agent scout');
    const routines = JSON.parse(
      readFileSync(join(home2, 'agents', 'scout2', 'routines.json'), 'utf8'),
    ) as Array<{ agentId: string }>;
    expect(routines[0]!.agentId).toBe('scout2');
    expect(readFileSync(join(home2, 'agents', 'scout2', 'skills', 'greet', 'SKILL.md'), 'utf8')).toContain('# Greet');
    expect(memory2.data.some((e) => e['namespace'] === 'scout2' && e['key'] === 'color')).toBe(true);

    removeUnpackedAgent(home2, 'scout2');
    expect(() => new AgentRegistry(join(home2, 'agents')).get('scout2')).toThrow();
  });

  it('rejects unknown agents, duplicate ids, and unsafe skill paths', () => {
    const home = mkdtempSync(join(tmpdir(), 'omni-pack3-'));
    const memory = stubMemory();
    expect(() => packAgent(home, 'nope', memory)).toThrow(/Unknown agent/);

    seedAgent(home, 'scout', memory);
    const pack = packAgent(home, 'scout', memory);
    expect(() => unpackAgent(home, pack, memory)).toThrow(/already exists/);

    const evil = { ...pack, skills: [{ name: 'evil', files: { '../../x': 'pwn' } }] };
    expect(() => unpackAgent(home, evil, memory, 'scout-evil')).toThrow(/unsafe path/);
  });

  it('rejects malformed packs', () => {
    const home = mkdtempSync(join(tmpdir(), 'omni-pack4-'));
    const memory = stubMemory();
    expect(() => unpackAgent(home, null, memory)).toThrow(/not an object/);
    expect(() => unpackAgent(home, { version: 2 }, memory)).toThrow(/unsupported version/);
    expect(() => unpackAgent(home, { version: 1, agent: {} }, memory)).toThrow(/agent.id/);
  });
});
