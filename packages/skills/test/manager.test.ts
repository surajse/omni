import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { learnSkillFromTranscript } from '../src/learn.js';
import { SkillManager } from '../src/manager.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'omni-skills-test-'));
}

describe('SkillManager', () => {
  it('saves, lists, gets and removes skills as SKILL.md + skill.json', () => {
    const mgr = new SkillManager(tmpDir());
    const skill = learnSkillFromTranscript('triage-inbox', 'Triage the inbox', [
      { name: 'gmail.list', args: {} },
    ]);
    mgr.save(skill);
    expect(mgr.list().map((s) => s.name)).toEqual(['triage-inbox']);
    expect(mgr.get('triage-inbox').description).toBe('Triage the inbox');
    mgr.remove('triage-inbox');
    expect(mgr.list()).toEqual([]);
  });

  it('lists skills sorted by name and skips invalid directories', () => {
    const dir = tmpDir();
    const mgr = new SkillManager(dir);
    mgr.save(learnSkillFromTranscript('zebra', 'Z', []));
    mgr.save(learnSkillFromTranscript('alpha', 'A', []));
    mkdirSync(join(dir, 'not-a-skill'));
    writeFileSync(join(dir, 'not-a-skill', 'random.txt'), 'junk');
    expect(mgr.list().map((s) => s.name)).toEqual(['alpha', 'zebra']);
  });

  it('throws clean errors for unknown skills and invalid names', () => {
    const mgr = new SkillManager(tmpDir());
    expect(() => mgr.get('nope')).toThrow('Unknown skill: nope');
    expect(() => mgr.remove('nope')).toThrow('Unknown skill: nope');
    expect(() =>
      mgr.save(learnSkillFromTranscript('Bad Name', 'd', [])),
    ).toThrow('Invalid skill name');
  });

  it('promptFragment injects skill summaries for system prompts', () => {
    const mgr = new SkillManager(tmpDir());
    mgr.save(
      learnSkillFromTranscript('triage-inbox', 'Triage the inbox', [
        { name: 'gmail.list', args: {} },
        { name: 'gmail.archive', args: {} },
      ]),
    );
    const frag = mgr.promptFragment();
    expect(frag).toContain('## Available skills');
    expect(frag).toContain('**triage-inbox**: Triage the inbox');
    expect(frag).toContain('`gmail.list`');
    const empty = new SkillManager(tmpDir()).promptFragment();
    expect(empty).toBe('');
  });

  it('promptFragment ignores unknown names instead of erroring', () => {
    const mgr = new SkillManager(tmpDir());
    mgr.save(learnSkillFromTranscript('real', 'Real skill', []));
    const frag = mgr.promptFragment(['real', 'ghost-skill']);
    expect(frag).toContain('**real**');
    expect(frag).not.toContain('ghost-skill');
  });
});
