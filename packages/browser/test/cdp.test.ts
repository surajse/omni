import { describe, expect, it } from 'vitest';
import { connectCdp, resolveCdpWebSocketUrl } from '../src/cdp.js';
import type { CdpSocket } from '../src/cdp.js';

/** In-memory fake WebSocket: the test drives both sides. */
class FakeSocket implements CdpSocket {
  sent: string[] = [];
  onmessage: ((data: string) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  /** Deliver a CDP frame to the client. */
  receive(obj: unknown): void {
    this.onmessage?.(JSON.stringify(obj));
  }
  open(): void {
    this.onopen?.();
  }
}

function lastSent(sock: FakeSocket): { id: number; method: string; params: unknown } {
  return JSON.parse(sock.sent[sock.sent.length - 1]!) as { id: number; method: string; params: unknown };
}

describe('connectCdp', () => {
  it('resolves after open and frames requests with incrementing ids', async () => {
    const sock = new FakeSocket();
    const connP = connectCdp('ws://localhost:9222/devtools/page/1', { socketFactory: () => sock });
    sock.open();
    const conn = await connP;
    const resP = conn.send('Page.navigate', { url: 'https://example.com' });
    expect(lastSent(sock)).toMatchObject({ id: 1, method: 'Page.navigate' });
    const resP2 = conn.send('Runtime.evaluate', {});
    expect(lastSent(sock)).toMatchObject({ id: 2, method: 'Runtime.evaluate' });
    sock.receive({ id: 1, result: { ok: true } });
    sock.receive({ id: 2, result: 42 });
    await expect(resP).resolves.toEqual({ ok: true });
    await expect(resP2).resolves.toBe(42);
    conn.close();
    expect(sock.closed).toBe(true);
  });

  it('rejects on CDP error responses with the remote message', async () => {
    const sock = new FakeSocket();
    const connP = connectCdp('ws://x', { socketFactory: () => sock });
    sock.open();
    const conn = await connP;
    const resP = conn.send('Bogus.method');
    sock.receive({ id: 1, error: { message: 'No such method' } });
    await expect(resP).rejects.toThrow(/CDP error: No such method/);
  });

  it('times out requests that never get a response', async () => {
    const sock = new FakeSocket();
    const connP = connectCdp('ws://x', { socketFactory: () => sock, timeoutMs: 20 });
    sock.open();
    const conn = await connP;
    await expect(conn.send('Page.navigate')).rejects.toThrow(/timed out.*Page\.navigate/);
  });

  it('dispatches events to subscribers; subscriber errors do not break dispatch', async () => {
    const sock = new FakeSocket();
    const connP = connectCdp('ws://x', { socketFactory: () => sock });
    sock.open();
    const conn = await connP;
    const seen: unknown[] = [];
    const off = conn.on('Page.loadEventFired', (p) => seen.push(p));
    conn.on('Page.loadEventFired', () => {
      throw new Error('boom');
    });
    sock.receive({ method: 'Page.loadEventFired', params: { ts: 1 } });
    expect(seen).toEqual([{ ts: 1 }]);
    off();
    sock.receive({ method: 'Page.loadEventFired', params: {} });
    expect(seen).toHaveLength(1);
  });

  it('ignores non-JSON frames and unknown response ids', async () => {
    const sock = new FakeSocket();
    const connP = connectCdp('ws://x', { socketFactory: () => sock });
    sock.open();
    const conn = await connP;
    const resP = conn.send('Page.enable');
    sock.onmessage?.('not json {{{');
    sock.receive({ id: 999, result: {} });
    sock.receive({ id: 1, result: {} });
    await expect(resP).resolves.toEqual({});
  });

  it('rejects connect when the socket errors before open', async () => {
    const sock = new FakeSocket();
    const connP = connectCdp('ws://nope:1', { socketFactory: () => sock, timeoutMs: 50 });
    sock.onerror?.(new Error('ECONNREFUSED'));
    await expect(connP).rejects.toThrow(/CDP connect failed/);
  });

  it('rejects connect on timeout when open never fires', async () => {
    const sock = new FakeSocket();
    await expect(
      connectCdp('ws://nope:1', { socketFactory: () => sock, timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/);
  });

  it('a socket error mid-flight rejects all pending requests', async () => {
    const sock = new FakeSocket();
    const connP = connectCdp('ws://x', { socketFactory: () => sock });
    sock.open();
    const conn = await connP;
    const p1 = conn.send('A');
    const p2 = conn.send('B');
    sock.onerror?.(new Error('dropped'));
    await expect(p1).rejects.toThrow(/socket error/);
    await expect(p2).rejects.toThrow(/socket error/);
  });
});

describe('resolveCdpWebSocketUrl', () => {
  const fakeFetch = (
    impl: (u: string) => Promise<{ ok: boolean; status?: number; json?: () => Promise<unknown> }>,
  ): typeof fetch => {
    const fn = (async (u: string | URL | Request) => {
      const res = await impl(String(u));
      return {
        ok: res.ok,
        status: res.status ?? 200,
        json: res.json ?? (async () => null),
      };
    }) as unknown as typeof fetch;
    return fn;
  };

  it('passes ws:// URLs through untouched', async () => {
    const url = 'ws://localhost:9222/devtools/page/abc';
    await expect(
      resolveCdpWebSocketUrl(url, fakeFetch(async () => {
        throw new Error('fetch must not be called');
      })),
    ).resolves.toBe(url);
  });

  it('discovers the page target from /json/list', async () => {
    const seen: string[] = [];
    const url = await resolveCdpWebSocketUrl(
      'http://localhost:9222',
      fakeFetch(async (u) => {
        seen.push(u);
        return {
          ok: true,
          json: async () => [
            { type: 'background_page', webSocketDebuggerUrl: 'ws://x/bg' },
            { type: 'page', webSocketDebuggerUrl: 'ws://x/page1' },
          ],
        };
      }),
    );
    expect(seen).toEqual(['http://localhost:9222/json/list']);
    expect(url).toBe('ws://x/page1');
  });

  it('throws a helpful error when no page target exists', async () => {
    await expect(
      resolveCdpWebSocketUrl(
        'http://localhost:9222',
        fakeFetch(async () => ({ ok: true, json: async () => [] })),
      ),
    ).rejects.toThrow(/no page target/);
  });

  it('throws on discovery HTTP failure', async () => {
    await expect(
      resolveCdpWebSocketUrl(
        'http://localhost:9222',
        fakeFetch(async () => ({ ok: false, status: 500 })),
      ),
    ).rejects.toThrow(/HTTP 500/);
  });
});
