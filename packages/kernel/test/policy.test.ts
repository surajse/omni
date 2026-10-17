import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../src/policy.js';

describe('PolicyEngine', () => {
  it('exact rule wins over a later wildcard', () => {
    const engine = new PolicyEngine([
      { match: 'shell', effect: 'deny' },
      { match: 'shell_*', effect: 'allow' },
    ]);
    expect(engine.decide('shell', false)).toBe('deny');
    expect(engine.decide('shell_exec', false)).toBe('allow');
  });

  it('single-star suffix acts as a prefix wildcard', () => {
    const engine = new PolicyEngine([{ match: 'read_*', effect: 'allow' }]);
    expect(engine.decide('read_file', true)).toBe('allow');
    expect(engine.decide('write_file', false)).toBe('ask');
  });

  it('double-star suffix also acts as a prefix wildcard', () => {
    const engine = new PolicyEngine([{ match: 'fs**', effect: 'deny' }]);
    expect(engine.decide('fs_write', false)).toBe('deny');
    expect(engine.decide('fs_read', true)).toBe('deny');
    expect(engine.decide('other', true)).toBe('allow');
  });

  it('defaults: read-only allows, writes ask', () => {
    const engine = new PolicyEngine([]);
    expect(engine.decide('get_time', true)).toBe('allow');
    expect(engine.decide('write_file', false)).toBe('ask');
  });

  it('unknown tools default to ask (not read-only)', () => {
    const engine = new PolicyEngine([]);
    expect(engine.decide('mystery_tool', false)).toBe('ask');
  });
});
