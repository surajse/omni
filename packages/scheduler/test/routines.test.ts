import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RoutineStore } from '../src/routines.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'omni-routines-'));
}

describe('RoutineStore', () => {
  it('CRUD roundtrip', () => {
    const store = new RoutineStore(tmpHome());
    expect(store.list()).toEqual([]);

    const r = store.add({ agentId: 'scout', cron: '*/5 * * * *', task: 'check inbox' });
    expect(r.id).toMatch(/^r_[0-9a-f]+$/);
    expect(r.enabled).toBe(true);
    expect(r.agentId).toBe('scout');

    expect(store.list()).toHaveLength(1);
    expect(store.get(r.id).task).toBe('check inbox');

    const toggled = store.toggle(r.id, false);
    expect(toggled.enabled).toBe(false);
    expect(store.get(r.id).enabled).toBe(false);

    store.remove(r.id);
    expect(store.list()).toEqual([]);
  });

  it('persists across instances and rejects bad input', () => {
    const home = tmpHome();
    const a = new RoutineStore(home);
    const r = a.add({ agentId: 's', cron: '0 9 * * *', task: 'morning brief', enabled: false });
    const b = new RoutineStore(home);
    expect(b.list()).toHaveLength(1);
    expect(b.get(r.id).enabled).toBe(false);

    expect(() => a.add({ agentId: 's', cron: 'nope', task: 'x' })).toThrow(/invalid cron/);
    expect(() => a.add({ agentId: 's', cron: '* * * * *', task: '   ' })).toThrow(/must not be empty/);
    expect(() => a.get('r_missing')).toThrow(/not found/);
    expect(() => a.remove('r_missing')).toThrow(/not found/);
    expect(() => a.toggle('r_missing', true)).toThrow(/not found/);
  });

  it('writes valid JSON to routines.json', () => {
    const home = tmpHome();
    const store = new RoutineStore(home);
    store.add({ agentId: 's', cron: '* * * * *', task: 't' });
    const parsed = JSON.parse(readFileSync(join(home, 'routines.json'), 'utf8'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].cron).toBe('* * * * *');
  });
});
