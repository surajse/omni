import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRegistry, type AgentConfig, type PackMemoryStore } from '@omni/kernel';
import { TeamManager } from '../src/manager.js';

function stubMemory(): PackMemoryStore {
  const data: Array<Record<string, string>> = [];
  return {
    exportJson: (namespace?: string) =>
      JSON.stringify(data.filter((e) => namespace === undefined || e['namespace'] === namespace)),
    importJson: (json: string) => {
      for (const e of JSON.parse(json) as Array<Record<string, string>>) data.push(e);
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

describe('TeamManager', () => {
  it('init → publish → install roundtrips an agent through a team', () => {
    const home = mkdtempSync(join(tmpdir(), 'omni-team-home-'));
    const teamsRoot = mkdtempSync(join(tmpdir(), 'omni-teams-'));
    const memory = stubMemory();
    new AgentRegistry(join(home, 'agents')).create(makeConfig('scout'));
    memory.importJson(JSON.stringify([{ namespace: 'scout', key: 'color', value: 'blue' }]));

    const teams = new TeamManager(teamsRoot);
    expect(teams.list()).toEqual([]);
    teams.init('acme');
    expect(teams.list()).toEqual(['acme']);
    expect(() => teams.init('acme')).toThrow(/already exists/);
    expect(() => teams.init('Bad Name')).toThrow(/invalid team name/);

    teams.publish(home, 'scout', 'acme', memory);
    expect(teams.listAgents('acme')).toEqual(['scout']);

    // A second home installs the shared agent under a new id.
    const home2 = mkdtempSync(join(tmpdir(), 'omni-team-home2-'));
    const memory2 = stubMemory();
    const config = teams.install(home2, 'acme', 'scout', memory2, 'scout-copy');
    expect(config.id).toBe('scout-copy');
    expect(new AgentRegistry(join(home2, 'agents')).get('scout-copy').name).toBe('Agent scout');

    expect(() => teams.install(home2, 'acme', 'nope', memory2)).toThrow(/has no agent/);
    expect(() => teams.publish(home, 'nope', 'acme', memory)).toThrow(/Unknown agent/);
    expect(() => teams.publish(home, 'scout', 'nope', memory)).toThrow(/unknown team/);

    teams.removeAgent('acme', 'scout');
    expect(teams.listAgents('acme')).toEqual([]);
    expect(() => teams.removeAgent('acme', 'scout')).toThrow(/has no agent/);
  });

  it('shares one teams root across processes (filesystem model)', () => {
    const home = mkdtempSync(join(tmpdir(), 'omni-team-h-'));
    const teamsRoot = mkdtempSync(join(tmpdir(), 'omni-team-r-'));
    const memory = stubMemory();
    new AgentRegistry(join(home, 'agents')).create(makeConfig('a1'));
    const dir = join(home, 'agents', 'a1');
    mkdirSync(join(dir, 'skills', 's1'), { recursive: true });
    writeFileSync(join(dir, 'skills', 's1', 'SKILL.md'), '# s1');

    new TeamManager(teamsRoot).init('t');
    // A "second process" sees the same team.
    const teams2 = new TeamManager(teamsRoot);
    teams2.publish(home, 'a1', 't', memory);
    expect(teams2.listAgents('t')).toEqual(['a1']);
  });
});
