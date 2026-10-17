import { describe, expect, it } from 'vitest';
import { learnSkillFromTranscript, renderSkillMd } from '../src/learn.js';

describe('learnSkillFromTranscript', () => {
  it('compresses a call sequence into human-readable steps', () => {
    const skill = learnSkillFromTranscript('triage-inbox', 'Triage the inbox', [
      { name: 'gmail.list', args: { q: 'is:unread' } },
      { name: 'gmail.read', args: { id: 'a1' } },
      { name: 'gmail.archive', args: { id: 'a1' } },
    ]);
    expect(skill.name).toBe('triage-inbox');
    expect(skill.version).toBe('1.0.0');
    expect(skill.steps).toEqual([
      'Call gmail.list with {"q":"is:unread"}',
      'Call gmail.read with {"id":"a1"}',
      'Call gmail.archive with {"id":"a1"}',
    ]);
    expect(skill.requiredTools).toEqual(['gmail.list', 'gmail.read', 'gmail.archive']);
    expect(skill.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('collapses 3+ consecutive identical tool names into a Repeat step', () => {
    const skill = learnSkillFromTranscript('bulk-archive', 'Archive many', [
      { name: 'gmail.archive', args: { id: 'a1' } },
      { name: 'gmail.archive', args: { id: 'a2' } },
      { name: 'gmail.archive', args: { id: 'a3' } },
      { name: 'gmail.archive', args: { id: 'a4' } },
    ]);
    expect(skill.steps).toEqual(['Repeat 4×: Call gmail.archive with {"id":"a1"}']);
    expect(skill.requiredTools).toEqual(['gmail.archive']);
  });

  it('keeps 2 consecutive identical calls as separate steps', () => {
    const skill = learnSkillFromTranscript('two-reads', 'Read twice', [
      { name: 'gmail.read', args: { id: 'a1' } },
      { name: 'gmail.read', args: { id: 'a2' } },
    ]);
    expect(skill.steps).toHaveLength(2);
    expect(skill.steps[0]).toContain('gmail.read');
  });

  it('records requiredTools in order of first use, deduplicated', () => {
    const skill = learnSkillFromTranscript('mixed', 'Mixed', [
      { name: 'b.tool', args: {} },
      { name: 'a.tool', args: {} },
      { name: 'b.tool', args: {} },
    ]);
    expect(skill.requiredTools).toEqual(['b.tool', 'a.tool']);
  });

  it('summarizes empty args as no arguments and truncates long args', () => {
    const skill = learnSkillFromTranscript('empty', 'Empty args', [{ name: 't', args: {} }]);
    expect(skill.steps[0]).toBe('Call t no arguments');
    const long = learnSkillFromTranscript('long', 'Long args', [
      { name: 't', args: { big: 'x'.repeat(500) } },
    ]);
    expect(long.steps[0]!.length).toBeLessThan(200);
    expect(long.steps[0]).toContain('…');
  });

  it('rejects invalid skill names and empty descriptions', () => {
    expect(() => learnSkillFromTranscript('Bad Name!', 'd', [])).toThrow('Invalid skill name');
    expect(() => learnSkillFromTranscript('ok-name', '   ', [])).toThrow('description');
  });

  it('accepts createdFrom provenance and custom version', () => {
    const skill = learnSkillFromTranscript('s', 'd', [], {
      createdFrom: 'run abc123',
      version: '2.1.0',
    });
    expect(skill.createdFrom).toBe('run abc123');
    expect(skill.version).toBe('2.1.0');
  });
});

describe('renderSkillMd', () => {
  it('renders a numbered SKILL.md with tools and usage', () => {
    const skill = learnSkillFromTranscript('triage-inbox', 'Triage the inbox', [
      { name: 'gmail.list', args: { q: 'is:unread' } },
    ]);
    const md = renderSkillMd(skill);
    expect(md).toContain('# triage-inbox');
    expect(md).toContain('> Triage the inbox');
    expect(md).toContain('1. Call gmail.list with {"q":"is:unread"}');
    expect(md).toContain('## Required tools');
    expect(md).toContain('`gmail.list`');
    expect(md).toContain('## Usage');
  });
});
