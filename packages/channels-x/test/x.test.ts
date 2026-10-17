// Tests for XChannel with a mocked fetch: user resolution, mention polling
// order, threaded replies, since_id advancement, self-skip, 429 backoff.
import { describe, expect, it } from 'vitest';
import { XChannel } from '../src/x.js';

interface Seen {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Build a fetch mock that replays scripted responses in order. */
function scriptedFetch(script: Array<(seen: Seen) => Response>): {
  fetchImpl: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const entry: Seen = { url, init: init ?? {} };
    seen.push(entry);
    const fn = script[Math.min(i++, script.length - 1)];
    return fn!(entry);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const authHeaderOf = (s: Seen): string => (s.init.headers as Record<string, string>)['authorization'] ?? '';

const MENTIONS_PAGE = (tweets: unknown[], newest?: string) =>
  jsonResponse({
    data: tweets,
    includes: { users: [{ id: 'u1', username: 'alice' }] },
    meta: { result_count: tweets.length, ...(newest ? { newest_id: newest } : {}) },
  });

describe('XChannel', () => {
  it('resolves own user id, polls mentions oldest-first, threads replies', async () => {
    const { fetchImpl, seen } = scriptedFetch([
      () => jsonResponse({ data: { id: 'me1', username: 'bot' } }), // /users/me
      () =>
        MENTIONS_PAGE(
          [
            { id: '200', text: '@bot second', author_id: 'u1' },
            { id: '100', text: '@bot first', author_id: 'u1' },
          ],
          '200',
        ),
      () => jsonResponse({ data: { id: 'r1', text: 'reply' } }, 201), // reply to 100
      () => jsonResponse({ data: { id: 'r2', text: 'reply' } }, 201), // reply to 200
      () => MENTIONS_PAGE([]), // next poll: nothing new
    ]);
    const channel = new XChannel({
      consumerKey: 'ck',
      consumerSecret: 'cs',
      accessToken: 't',
      accessTokenSecret: 'ts',
      pollIntervalMs: 20,
      fetchImpl,
    });
    const handled: string[] = [];
    channel.onMessage(async (text) => {
      handled.push(text);
      return `got: ${text}`;
    });
    const run = channel.start();
    await new Promise((r) => setTimeout(r, 120));
    await channel.stop();
    await run;

    expect(channel.ownUserId()).toBe('me1');
    // oldest-first order despite newest-first API response
    expect(handled).toEqual(['@bot first', '@bot second']);
    // every request carries an OAuth header, never raw secrets
    for (const s of seen) {
      expect(authHeaderOf(s).startsWith('OAuth ')).toBe(true);
      expect(authHeaderOf(s)).not.toContain('cs');
    }
    const posts = seen.filter((s) => s.url.endsWith('/tweets'));
    expect(posts).toHaveLength(2);
    const bodies = posts.map((s) => JSON.parse(s.init.body as string) as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ reply: { in_reply_to_tweet_id: '100' } });
    expect(bodies[1]).toMatchObject({ reply: { in_reply_to_tweet_id: '200' } });
    // since_id advanced on the follow-up poll
    const polls = seen.filter((s) => s.url.includes('/mentions'));
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(polls[1]!.url).toContain('since_id=200');
  });

  it('skips its own tweets', async () => {
    const { fetchImpl, seen } = scriptedFetch([
      () => jsonResponse({ data: { id: 'me1', username: 'bot' } }),
      () => MENTIONS_PAGE([{ id: '300', text: '@bot hello', author_id: 'me1' }], '300'),
      () => MENTIONS_PAGE([]),
    ]);
    const channel = new XChannel({
      consumerKey: 'ck',
      consumerSecret: 'cs',
      accessToken: 't',
      accessTokenSecret: 'ts',
      pollIntervalMs: 20,
      fetchImpl,
    });
    let calls = 0;
    channel.onMessage(async () => {
      calls++;
    });
    const run = channel.start();
    await new Promise((r) => setTimeout(r, 80));
    await channel.stop();
    await run;
    expect(calls).toBe(0);
    expect(seen.filter((s) => s.url.endsWith('/tweets'))).toHaveLength(0);
  });

  it('backs off on 429 without crashing the loop', async () => {
    const { fetchImpl } = scriptedFetch([
      () => jsonResponse({ data: { id: 'me1', username: 'bot' } }),
      () => jsonResponse({ title: 'Too Many Requests' }, 429, { 'retry-after': '0' }),
      () => MENTIONS_PAGE([]),
    ]);
    const channel = new XChannel({
      consumerKey: 'ck',
      consumerSecret: 'cs',
      accessToken: 't',
      accessTokenSecret: 'ts',
      pollIntervalMs: 20,
      fetchImpl,
    });
    channel.onMessage(async () => {});
    const run = channel.start();
    await new Promise((r) => setTimeout(r, 100));
    await channel.stop();
    await run; // resolves: the loop survived the 429
  });

  it('send() posts a standalone tweet', async () => {
    const { fetchImpl, seen } = scriptedFetch([() => jsonResponse({ data: { id: 't9' } }, 201)]);
    const channel = new XChannel({
      consumerKey: 'ck',
      consumerSecret: 'cs',
      accessToken: 't',
      accessTokenSecret: 'ts',
      fetchImpl,
    });
    await channel.send('hello world');
    expect(seen).toHaveLength(1);
    const body = JSON.parse(seen[0]!.init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ text: 'hello world' });
  });

  it('requires onMessage before start() and all credentials', () => {
    expect(
      () => new XChannel({ consumerKey: '', consumerSecret: 's', accessToken: 't', accessTokenSecret: 'ts' }),
    ).toThrow('consumerKey');
  });
});
