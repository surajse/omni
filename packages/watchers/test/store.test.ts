import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WatchStore } from '../src/store.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'omni-watch-store-'));
}

describe('WatchStore', () => {
  it('adds, lists, gets, removes watches', () => {
    const store = new WatchStore(tmpHome());
    expect(store.list()).toEqual([]);
    const w = store.add({
      agentId: 'scout',
      target: { kind: 'url', ref: 'https://example.com' },
      every: '*/15 * * * *',
      task: 'check the price',
    });
    expect(w.id).toMatch(/^w_/);
    expect(w.cooldownMinutes).toBe(60);
    expect(store.list()).toHaveLength(1);
    expect(store.get(w.id).task).toBe('check the price');
    store.remove(w.id);
    expect(store.list()).toEqual([]);
  });

  it('rejects invalid cron and empty task', () => {
    const store = new WatchStore(tmpHome());
    expect(() =>
      store.add({ agentId: 'a', target: { kind: 'url', ref: 'https://x' }, every: 'nope', task: 't' }),
    ).toThrow(/invalid cron/i);
    expect(() =>
      store.add({ agentId: 'a', target: { kind: 'url', ref: 'https://x' }, every: '* * * * *', task: '  ' }),
    ).toThrow(/task must not be empty/);
  });

  it('rejects unknown ids', () => {
    const store = new WatchStore(tmpHome());
    expect(() => store.get('w_nope')).toThrow(/watch not found/);
    expect(() => store.remove('w_nope')).toThrow(/watch not found/);
  });

  it('stores and retrieves snapshots', () => {
    const store = new WatchStore(tmpHome());
    expect(store.getSnapshot('w_x')).toBeUndefined();
    const snap = { hash: 'abc', excerpt: 'hi', fetchedAt: new Date().toISOString() };
    store.setSnapshot('w_x', snap);
    expect(store.getSnapshot('w_x')).toEqual(snap);
  });
});
