import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkWatch } from '../src/engine.js';
import { WatchStore } from '../src/store.js';
import { parseWatchTarget, type Watch } from '../src/types.js';

function makeWatch(overrides: Partial<Watch> = {}): Watch {
  return {
    id: 'w_test',
    agentId: 'scout',
    target: parseWatchTarget('url:https://example.com'),
    every: '* * * * *',
    task: 'check it',
    cooldownMinutes: 60,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('checkWatch', () => {
  it('first fetch only stores the baseline (no false positive)', async () => {
    const store = new WatchStore(mkdtempSync(join(tmpdir(), 'omni-watch-eng-')));
    const watch = makeWatch();
    const res = await checkWatch(store, watch, async () => 'content v1');
    expect(res.changed).toBe(false);
    expect(store.getSnapshot(watch.id)?.hash).toBe(res.hash);
  });

  it('identical content is not a change', async () => {
    const store = new WatchStore(mkdtempSync(join(tmpdir(), 'omni-watch-eng-')));
    const watch = makeWatch();
    await checkWatch(store, watch, async () => 'same');
    const res = await checkWatch(store, watch, async () => 'same');
    expect(res.changed).toBe(false);
  });

  it('modified content reports changed with an excerpt', async () => {
    const store = new WatchStore(mkdtempSync(join(tmpdir(), 'omni-watch-eng-')));
    const watch = makeWatch();
    await checkWatch(store, watch, async () => 'price: $10');
    const res = await checkWatch(store, watch, async () => 'price: $99 dropped today!');
    expect(res.changed).toBe(true);
    expect(res.excerpt).toContain('$99');
  });

  it('cooldown suppresses repeat notifications', async () => {
    const store = new WatchStore(mkdtempSync(join(tmpdir(), 'omni-watch-eng-')));
    const watch = makeWatch({ cooldownMinutes: 60 });
    let content = 'v1';
    await checkWatch(store, watch, async () => content);
    content = 'v2';
    const first = await checkWatch(store, watch, async () => content);
    expect(first.changed).toBe(true);
    content = 'v3';
    const second = await checkWatch(store, watch, async () => content);
    expect(second.changed).toBe(false); // changed content, but cooldown not elapsed
  });

  it('propagates fetch failures', async () => {
    const store = new WatchStore(mkdtempSync(join(tmpdir(), 'omni-watch-eng-')));
    const watch = makeWatch();
    await expect(
      checkWatch(store, watch, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('parseWatchTarget', () => {
  it('parses url:, file:, cmd: specs', () => {
    expect(parseWatchTarget('url:https://example.com')).toEqual({ kind: 'url', ref: 'https://example.com' });
    expect(parseWatchTarget('file:/tmp/x.txt')).toEqual({ kind: 'file', ref: '/tmp/x.txt' });
    expect(parseWatchTarget('cmd:df -h /')).toEqual({ kind: 'command', ref: 'df -h /' });
  });

  it('rejects bad specs', () => {
    expect(() => parseWatchTarget('https://example.com')).toThrow(/invalid watch target/);
    expect(() => parseWatchTarget('url:')).toThrow(/invalid watch target/);
    expect(() => parseWatchTarget('ftp://x')).toThrow(/invalid watch target/);
  });
});
