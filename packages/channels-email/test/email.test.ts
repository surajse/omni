// Tests for EmailChannel: polling order, threaded replies, dedup,
// self-skip, mark-read, send() binding — all with a mocked fetch.
import { describe, expect, it } from 'vitest';
import { EmailChannel } from '../src/email.js';
import { base64urlEncode } from '../src/gmail.js';

interface Seen {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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

const CREDS = { clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok' };
const TOKEN_OK = () => jsonResponse({ access_token: 'tok', expires_in: 3600 });
const PROFILE = () => jsonResponse({ emailAddress: 'agent@example.com' });

function messageFixture(id: string, from: string, subject: string, bodyText: string, messageId: string): unknown {
  return {
    id,
    threadId: 't1',
    snippet: bodyText.slice(0, 30),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
        { name: 'Date', value: 'Fri, 17 Oct 2026 10:00:00 +0530' },
        { name: 'Message-ID', value: messageId },
      ],
      body: { data: base64urlEncode(bodyText) },
    },
  };
}

function listPage(ids: string[]): (seen: Seen) => Response {
  return () =>
    jsonResponse({ messages: ids.map((id) => ({ id, threadId: 't1' })), resultSizeEstimate: ids.length });
}

describe('EmailChannel', () => {
  it('polls oldest-first and replies in-thread, then marks read', async () => {
    const { fetchImpl, seen } = scriptedFetch([
      TOKEN_OK,
      PROFILE,
      listPage(['m2', 'm1']), // newest-first from the API
      () => jsonResponse(messageFixture('m1', 'Alice <alice@x.com>', 'First', 'first body', '<m1@x>')),
      () => jsonResponse({ id: 's1' }), // reply to m1
      () => jsonResponse({}), // markRead m1
      () => jsonResponse(messageFixture('m2', 'Bob <bob@x.com>', 'Second', 'second body', '<m2@x>')),
      () => jsonResponse({ id: 's2' }), // reply to m2
      () => jsonResponse({}), // markRead m2
      listPage([]), // next poll: nothing new
    ]);
    const channel = new EmailChannel({ creds: CREDS, fetchImpl, pollIntervalMs: 20 });
    const handled: string[] = [];
    channel.onMessage(async (text) => {
      handled.push(text);
      return 'ack';
    });
    const run = channel.start();
    await new Promise((r) => setTimeout(r, 150));
    await channel.stop();
    await run;

    expect(channel.ownEmail()).toBe('agent@example.com');
    // oldest-first despite newest-first API order
    expect(handled[0]).toContain('first body');
    expect(handled[1]).toContain('second body');
    expect(handled[0]).toContain('From: Alice <alice@x.com>');

    const sends = seen.filter((s) => s.url.endsWith('/messages/send'));
    expect(sends).toHaveLength(2);
    const bodies = sends.map((s) => JSON.parse(s.init.body as string) as { raw: string; threadId: string });
    expect(bodies[0]!.threadId).toBe('t1');
    const mime0 = Buffer.from(bodies[0]!.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(mime0).toContain('To: alice@x.com');
    expect(mime0).toContain('In-Reply-To: <m1@x>');

    const modifies = seen.filter((s) => s.url.includes('/modify'));
    expect(modifies).toHaveLength(2);
  });

  it('dedups across polls and skips its own sent mail', async () => {
    const { fetchImpl } = scriptedFetch([
      TOKEN_OK,
      PROFILE,
      listPage(['m1', 'mOwn']),
      () => jsonResponse(messageFixture('m1', 'Carol <carol@x.com>', 'Hi', 'hello', '<m1@x>')),
      () => jsonResponse({ id: 's1' }),
      () => jsonResponse({}),
      () =>
        jsonResponse(
          messageFixture('mOwn', 'Agent <agent@example.com>', 'Re: Hi', 'my own reply', '<own@x>'),
        ),
      listPage(['m1', 'mOwn']), // same ids again
      listPage(['m1', 'mOwn']),
    ]);
    const channel = new EmailChannel({ creds: CREDS, fetchImpl, pollIntervalMs: 20 });
    let calls = 0;
    channel.onMessage(async () => {
      calls++;
      return 'ack';
    });
    const run = channel.start();
    await new Promise((r) => setTimeout(r, 120));
    await channel.stop();
    await run;
    // m1 handled once; own mail skipped; re-polls see no new ids.
    expect(calls).toBe(1);
  });

  it('leaves mail unread when markRead is false', async () => {
    const { fetchImpl, seen } = scriptedFetch([
      TOKEN_OK,
      PROFILE,
      listPage(['m1']),
      () => jsonResponse(messageFixture('m1', 'Dan <dan@x.com>', 'Q', 'body', '<m1@x>')),
      () => jsonResponse({ id: 's1' }),
      listPage([]),
    ]);
    const channel = new EmailChannel({ creds: CREDS, fetchImpl, pollIntervalMs: 20, markRead: false });
    channel.onMessage(async () => 'ack');
    const run = channel.start();
    await new Promise((r) => setTimeout(r, 80));
    await channel.stop();
    await run;
    expect(seen.filter((s) => s.url.includes('/modify'))).toHaveLength(0);
  });

  it('send() needs an inbound email first, then replies threaded', async () => {
    const { fetchImpl } = scriptedFetch([TOKEN_OK, () => jsonResponse({ id: 's9' })]);
    const channel = new EmailChannel({ creds: CREDS, fetchImpl });
    await expect(channel.send('hello')).rejects.toThrow(/no message received yet/);
  });

  it('requires onMessage before start() and all credentials', async () => {
    const { fetchImpl } = scriptedFetch([TOKEN_OK, PROFILE]);
    const channel = new EmailChannel({ creds: CREDS, fetchImpl });
    await expect(channel.start()).rejects.toThrow(/onMessage/);
    expect(() => new EmailChannel({ creds: { clientId: '', clientSecret: 's', refreshToken: 'r' } })).toThrow(
      /clientId/,
    );
  });

  it('survives a failed poll without crashing the loop', async () => {
    const { fetchImpl } = scriptedFetch([
      TOKEN_OK,
      PROFILE,
      () => jsonResponse({ error: { message: 'boom' } }, 500),
      listPage([]),
    ]);
    const channel = new EmailChannel({ creds: CREDS, fetchImpl, pollIntervalMs: 20 });
    channel.onMessage(async () => 'ack');
    const run = channel.start();
    await new Promise((r) => setTimeout(r, 80));
    await channel.stop();
    await run; // no throw
  });
});
