import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SlackChannel, stripMention, verifySlackSignature } from '../src/slack.js';

const SECRET = 'test-signing-secret';
const NOW = 1_700_000_000;

function sign(timestamp: string, body: string, secret = SECRET): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`, 'utf8').digest('hex');
}

describe('verifySlackSignature', () => {
  const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
  const ts = String(NOW);

  it('accepts a valid signature', () => {
    expect(
      verifySlackSignature({ signingSecret: SECRET, timestamp: ts, body, signature: sign(ts, body), nowSec: () => NOW }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: ts,
        body: body + 'x',
        signature: sign(ts, body),
        nowSec: () => NOW,
      }),
    ).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(
      verifySlackSignature({
        signingSecret: 'other',
        timestamp: ts,
        body,
        signature: sign(ts, body),
        nowSec: () => NOW,
      }),
    ).toBe(false);
  });

  it('rejects stale and future timestamps (5-minute tolerance)', () => {
    const sig = (t: string): boolean =>
      verifySlackSignature({ signingSecret: SECRET, timestamp: t, body, signature: sign(t, body), nowSec: () => NOW });
    expect(sig(String(NOW - 301))).toBe(false);
    expect(sig(String(NOW + 301))).toBe(false);
    expect(sig(String(NOW - 299))).toBe(true);
    expect(sig('not-a-number')).toBe(false);
  });

  it('rejects malformed signatures', () => {
    expect(
      verifySlackSignature({ signingSecret: SECRET, timestamp: ts, body, signature: 'v0=short', nowSec: () => NOW }),
    ).toBe(false);
  });
});

describe('stripMention', () => {
  it('strips a leading user mention', () => {
    expect(stripMention('<@U12345> hello there')).toBe('hello there');
    expect(stripMention('hello <@U12345>')).toBe('hello <@U12345>');
    expect(stripMention('plain text')).toBe('plain text');
  });
});

/** Build a channel whose Slack API calls are mocked; real http server for webhooks. */
function makeChannel() {
  const apiCalls: Array<{ method: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = String(url).split('/api/')[1];
    const body = JSON.parse(String(init?.body ?? '{}')) as unknown;
    apiCalls.push({ method, body });
    if (method === 'auth.test') {
      return { ok: true, json: async () => ({ ok: true, user_id: 'UBOT' }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  }) as typeof fetch;
  const channel = new SlackChannel({
    botToken: 'xoxb-test',
    signingSecret: SECRET,
    fetchImpl,
    nowSec: () => NOW,
  });
  return { channel, apiCalls };
}

async function post(port: number, payload: unknown, opts: { ts?: string; secret?: string } = {}): Promise<Response> {
  const body = JSON.stringify(payload);
  const ts = opts.ts ?? String(NOW);
  return fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-signature': sign(ts, body, opts.secret ?? SECRET),
      'x-slack-request-timestamp': ts,
    },
    body,
  });
}

describe('SlackChannel webhook', () => {
  it('answers url_verification challenges', async () => {
    const { channel } = makeChannel();
    channel.onMessage(async () => 'never');
    await channel.start(0);
    const port = channel.localPort()!;
    try {
      const res = await post(port, { type: 'url_verification', challenge: 'ch-123' });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ch-123');
    } finally {
      await channel.stop();
    }
  });

  it('rejects requests with a bad signature (401)', async () => {
    const { channel } = makeChannel();
    channel.onMessage(async () => 'never');
    await channel.start(0);
    const port = channel.localPort()!;
    try {
      const res = await post(port, { type: 'url_verification', challenge: 'x' }, { secret: 'wrong' });
      expect(res.status).toBe(401);
    } finally {
      await channel.stop();
    }
  });

  it('routes app_mention to the handler and threads the reply', async () => {
    const { channel, apiCalls } = makeChannel();
    const seen: string[] = [];
    channel.onMessage(async (text) => {
      seen.push(text);
      return 'on it';
    });
    await channel.start(0);
    const port = channel.localPort()!;
    try {
      const res = await post(port, {
        type: 'event_callback',
        event: { type: 'app_mention', user: 'U1', text: '<@UBOT> deploy the thing', channel: 'C1', ts: '111.222' },
      });
      expect(res.status).toBe(200);
      // Give the async dispatch a tick to finish.
      await new Promise((r) => setTimeout(r, 50));
      expect(seen).toEqual(['deploy the thing']);
      const postCall = apiCalls.find((c) => c.method === 'chat.postMessage');
      expect(postCall?.body).toMatchObject({ channel: 'C1', text: 'on it', thread_ts: '111.222' });
    } finally {
      await channel.stop();
    }
  });

  it('routes human messages, ignores bot messages and edits', async () => {
    const { channel } = makeChannel();
    const seen: string[] = [];
    channel.onMessage(async (text) => {
      seen.push(text);
      return '';
    });
    await channel.start(0);
    const port = channel.localPort()!;
    try {
      await post(port, {
        type: 'event_callback',
        event: { type: 'message', user: 'U2', text: 'hello', channel: 'C2', ts: '1.1' },
      });
      await post(port, {
        type: 'event_callback',
        event: { type: 'message', subtype: 'bot_message', bot_id: 'B1', text: 'bot says', channel: 'C2', ts: '1.2' },
      });
      await post(port, {
        type: 'event_callback',
        event: { type: 'message', subtype: 'message_changed', user: 'U2', text: 'edited', channel: 'C2', ts: '1.3' },
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(seen).toEqual(['hello']);
    } finally {
      await channel.stop();
    }
  });

  it('send() posts to the last inbound channel; throws before any message', async () => {
    const { channel, apiCalls } = makeChannel();
    await expect(channel.send('hi')).rejects.toThrow(/no channel bound/);
    channel.onMessage(async () => {});
    await channel.start(0);
    const port = channel.localPort()!;
    try {
      await post(port, {
        type: 'event_callback',
        event: { type: 'message', user: 'U3', text: 'ping', channel: 'C9', ts: '5.5' },
      });
      await new Promise((r) => setTimeout(r, 50));
      await channel.send('manual reply');
      const postCall = apiCalls.find((c) => c.method === 'chat.postMessage' && (c.body as { text: string }).text === 'manual reply');
      expect(postCall?.body).toMatchObject({ channel: 'C9', thread_ts: '5.5' });
    } finally {
      await channel.stop();
    }
  });

  it('requires credentials and a handler', () => {
    expect(() => new SlackChannel({ botToken: '', signingSecret: SECRET })).toThrow(/botToken/);
    expect(() => new SlackChannel({ botToken: 'x', signingSecret: '' })).toThrow(/signingSecret/);
  });
});
