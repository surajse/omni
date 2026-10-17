import { describe, expect, it } from 'vitest';
import { parseAsId, parseOutFile, parseTeamFlag } from '../src/index.js';

describe('v0.4 CLI parsers', () => {
  it('parseOutFile reads --out', () => {
    expect(parseOutFile([])).toBeUndefined();
    expect(parseOutFile(['x', '--out', 'a.json'])).toBe('a.json');
    expect(() => parseOutFile(['--out'])).toThrow(/requires a file path/);
  });

  it('parseAsId reads and validates --as', () => {
    expect(parseAsId([])).toBeUndefined();
    expect(parseAsId(['--as', 'scout-2'])).toBe('scout-2');
    expect(() => parseAsId(['--as'])).toThrow(/requires an id/);
    expect(() => parseAsId(['--as', 'Bad Id'])).toThrow(/must match/);
  });

  it('parseTeamFlag requires --team', () => {
    expect(parseTeamFlag(['--team', 'acme'])).toBe('acme');
    expect(() => parseTeamFlag([])).toThrow(/requires --team/);
    expect(() => parseTeamFlag(['--team'])).toThrow(/requires --team/);
    expect(() => parseTeamFlag(['--team', 'ACME'])).toThrow(/must match/);
  });
});
