import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { learnFromLatestRun } from '../src/index.js';
import { SkillManager } from '@omni/skills';

function writeRun(agentDir: string, name: string, toolNames: string[]): void {
  const runsDir = join(agentDir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const lines = toolNames.map((tool, i) =>
    JSON.stringify({
      seq: i,
      at: '2026-10-17T00:00:00.000Z',
      event: { type: 'tool-call', call: { id: `c${i}`, name: tool, arguments: { q: 'x' } } },
    }),
  );
  writeFileSync(join(runsDir, name), lines.join('\n') + '\n');
}

describe('learnFromLatestRun', () => {
  it('learns a skill from the newest recorded run and saves it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-learn-test-'));
    writeRun(dir, '2026-01-01T00-00-00.jsonl', ['get_time']);
    writeRun(dir, '2026-01-02T00-00-00.jsonl', ['gmail.list', 'gmail.read', 'gmail.archive']);

    const skill = learnFromLatestRun(dir, 'triage-inbox', 'Triage the inbox');
    expect(skill.name).toBe('triage-inbox');
    expect(skill.steps).toHaveLength(3);
    expect(skill.requiredTools).toEqual(['gmail.list', 'gmail.read', 'gmail.archive']);
    expect(skill.createdFrom).toContain('2026-01-02');

    const saved = new SkillManager(join(dir, 'skills')).get('triage-inbox');
    expect(saved.description).toBe('Triage the inbox');
  });

  it('throws a helpful error when the agent has no recorded runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-learn-test-'));
    expect(() => learnFromLatestRun(dir, 's', 'd')).toThrow('no recorded runs');
  });

  it('rejects invalid skill names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-learn-test-'));
    writeRun(dir, 'r.jsonl', ['get_time']);
    expect(() => learnFromLatestRun(dir, 'Bad Name', 'd')).toThrow('Invalid skill name');
  });
});
