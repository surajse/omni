import { describe, expect, it } from 'vitest';
import { excerpt, isChanged, sha256hex } from '../src/diff.js';

describe('sha256hex', () => {
  it('is deterministic and 64 hex chars', () => {
    const a = sha256hex('hello world');
    expect(a).toBe(sha256hex('hello world'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different input', () => {
    expect(sha256hex('a')).not.toBe(sha256hex('b'));
  });
});

describe('excerpt', () => {
  it('returns short text as-is', () => {
    expect(excerpt('hello')).toBe('hello');
  });

  it('truncates long text with an ellipsis', () => {
    const long = 'x'.repeat(600);
    const e = excerpt(long, 500);
    expect(e.length).toBeLessThan(600);
    expect(e.endsWith('…')).toBe(true);
  });
});

describe('isChanged', () => {
  it('false with no baseline', () => {
    expect(isChanged(undefined, 'abc')).toBe(false);
  });

  it('false for identical hashes, true for different', () => {
    expect(isChanged('abc', 'abc')).toBe(false);
    expect(isChanged('abc', 'def')).toBe(true);
  });
});
