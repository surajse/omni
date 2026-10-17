import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '@omni/kernel';
import { SkillManager } from '@omni/skills';
import { RoutineStore } from '@omni/scheduler';
import { PackManager, readPackFile } from '../src/manager.js';
import { validatePack } from '../src/types.js';

const REPO_PACKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packs');

describe('shipped packs', () => {
  const mgr = new PackManager();
  const packs = mgr.listPacks(REPO_PACKS);
  const names = packs.map((p) => p.name);

  it('ships the four flagship packs', () => {
    expect(names).toEqual(['inbox-triage', 'meeting-prep', 'repo-watcher', 'researcher']);
  });

  for (const name of ['researcher', 'inbox-triage', 'repo-watcher', 'meeting-prep']) {
    it(`pack "${name}" validates and installs end-to-end`, () => {
      const home = mkdtempSync(join(tmpdir(), 'omni-pack-'));
      const res = mgr.installPack(home, REPO_PACKS, name);
      expect(res.agentId).toBeTruthy();
      expect(res.requires.length).toBeGreaterThan(0);

      // Agent exists with the pack's system prompt.
      const config = new AgentRegistry(join(home, 'agents')).get(res.agentId);
      const pack = readPackFile(join(REPO_PACKS, name));
      expect(config.systemPrompt).toBe(pack.agent.systemPrompt);
      expect(config.tools).toEqual(pack.agent.tools);

      // Skills written.
      const skills = new SkillManager(join(home, 'agents', res.agentId, 'skills')).list();
      expect(skills.map((s: { name: string }) => s.name).sort()).toEqual(
        pack.skills.map((s) => s.name).sort(),
      );
      expect(res.skills).toBe(pack.skills.length);

      // Routines added.
      const routines = new RoutineStore(join(home, 'agents', res.agentId)).list();
      expect(routines).toHaveLength(pack.routines.length);
      expect(res.routines).toBe(pack.routines.length);
    });
  }

  it('installs under a custom id with --as semantics', () => {
    const home = mkdtempSync(join(tmpdir(), 'omni-pack-'));
    const res = mgr.installPack(home, REPO_PACKS, 'researcher', 'my-researcher');
    expect(res.agentId).toBe('my-researcher');
    expect(new AgentRegistry(join(home, 'agents')).get('my-researcher').memoryNamespace).toBe(
      'my-researcher',
    );
  });

  it('rejects unknown packs', () => {
    const home = mkdtempSync(join(tmpdir(), 'omni-pack-'));
    expect(() => mgr.installPack(home, REPO_PACKS, 'nope')).toThrow();
  });
});

describe('validatePack', () => {
  it('rejects malformed packs with specific errors', () => {
    expect(validatePack(null).ok).toBe(false);
    const bad = validatePack({ name: 'Bad Name!', version: 'x', skills: [], routines: [] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.some((e) => e.includes('pack.name'))).toBe(true);
      expect(bad.errors.some((e) => e.includes('pack.version'))).toBe(true);
    }
  });

  it('rejects bad skill entries', () => {
    const res = validatePack({
      name: 'ok',
      version: '1.0.0',
      description: 'd',
      requires: [],
      agent: { name: 'A', systemPrompt: 'p', tools: [], policy: [] },
      skills: [{ name: 'BAD', description: '', steps: [], requiredTools: [] }],
      routines: [],
    });
    expect(res.ok).toBe(false);
  });
});
