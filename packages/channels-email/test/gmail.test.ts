// Tests for GmailApiBackend: OAuth2 refresh, list/get/markRead/send,
// MIME building, message parsing — all with a mocked fetch.
import { describe, expect, it } from 'vitest';
import {
  GmailApiBackend,
  parseGmailMessage,
  buildMime,
  base64urlEncode,
  base64urlDecode,
  encodeHeaderValue,
  extractEmailAddress,
  type GmailCredentials,
} from '../src/gmail.js';

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

const CREDS: GmailCredentials = { clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok' };
const TOKEN_OK = () => jsonResponse({ access_token: 'tok123', expires_in: 3600 });

const authOf = (s: Seen): string => (s.init.headers as Record<string, string>)['authorization'] ?? '';

/** A realistic messages.get format=full fixture: multipart/alternative. */
function fullMessageFixture(): unknown {
  const plain = base64urlEncode('Hello agent,\n\nPlease review the report.\n');
  const html = base64urlEncode('<p>Hello agent,</p>');
  return {
    id: 'm1',
    threadId: 't1',
    snippet: 'Hello agent, Please review',
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: 'Alice <alice@example.com>' },
        { name: 'Subject', value: 'Q3 report' },
        { name: 'Date', value: 'Fri, 17 Oct 2026 10:00:00 +0530' },
        { name: 'Message-ID', value: '<abc123@mail.example.com>' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: plain } },
        { mimeType: 'text/html', body: { data: html } },
      ],
    },
  };
}

describe('helpers', () => {
  it('base64url round-trips without padding or unsafe chars', () => {
    const enc = base64urlEncode('héllo → world ✓');
    expect(enc).not.toMatch(/[+/=]/);
    expect(base64urlDecode(enc)).toBe('héllo → world ✓');
  });

  it('extracts bare addresses from From headers', () => {
    expect(extractEmailAddress('Alice <alice@example.com>')).toBe('alice@example.com');
    expect(extractEmailAddress('bob@example.com')).toBe('bob@example.com');
  });

  it('encodes non-ASCII subjects (RFC 2047)', () => {
    expect(encodeHeaderValue('plain subject')).toBe('plain subject');
    const enc = encodeHeaderValue('रिपोर्ट Q3');
    expect(enc.startsWith('=?UTF-8?B?')).toBe(true);
  });

  it('builds a valid RFC822 message with threading headers', () => {
    const mime = buildMime({
      to: 'alice@example.com',
      subject: 'Re: Q3 report',
      body: 'On it.',
      inReplyTo: '<abc123@mail.example.com>',
      references: '<abc123@mail.example.com>',
    });
    expect(mime).toContain('To: alice@example.com');
    expect(mime).toContain('Subject: Re: Q3 report');
    expect(mime).toContain('In-Reply-To: <abc123@mail.example.com>');
    expect(mime).toContain('References: <abc123@mail.example.com>');
    expect(mime).toContain('Content-Type: text/plain; charset=utf-8');
    expect(mime.endsWith('On it.')).toBe(true);
  });
});

describe('parseGmailMessage', () => {
  it('parses headers and picks the text/plain part', () => {
    const parsed = parseGmailMessage(fullMessageFixture() as never);
    expect(parsed.id).toBe('m1');
    expect(parsed.threadId).toBe('t1');
    expect(parsed.from).toBe('Alice <alice@example.com>');
    expect(parsed.subject).toBe('Q3 report');
    expect(parsed.messageId).toBe('<abc123@mail.example.com>');
    expect(parsed.body).toContain('Please review the report.');
    expect(parsed.body).not.toContain('<p>');
  });

  it('falls back gracefully when no text part exists', () => {
    const parsed = parseGmailMessage({
      id: 'm2',
      threadId: 't2',
      snippet: 'just a snippet',
      payload: { mimeType: 'text/html', headers: [], body: { data: base64urlEncode('<b>x</b>') } },
    });
    expect(parsed.body).toBe('');
    expect(parsed.snippet).toBe('just a snippet');
    expect(parsed.subject).toBe('(no subject)');
  });
});

describe('GmailApiBackend', () => {
  it('throws on missing credentials', () => {
    expect(() => new GmailApiBackend({ creds: { clientId: '', clientSecret: 's', refreshToken: 'r' } })).toThrow(
      /clientId/,
    );
  });

  it('profile() validates credentials and returns the address', async () => {
    const { fetchImpl, seen } = scriptedFetch([TOKEN_OK, () => jsonResponse({ emailAddress: 'bot@example.com' })]);
    const backend = new GmailApiBackend({ creds: CREDS, fetchImpl });
    const profile = await backend.profile();
    expect(profile.emailAddress).toBe('bot@example.com');
    expect(seen[0]!.url).toContain('oauth2.googleapis.com/token');
    expect(seen[1]!.url).toContain('/users/me/profile');
    expect(authOf(seen[1]!)).toBe('Bearer tok123');
    // The refresh token is only ever sent to Google's token endpoint, never in errors.
    expect(seen[1]!.url).not.toContain('rtok');
  });

  it('listMessages sends the search query', async () => {
    const { fetchImpl, seen } = scriptedFetch([
      TOKEN_OK,
      () => jsonResponse({ messages: [{ id: 'm1', threadId: 't1' }], resultSizeEstimate: 1 }),
    ]);
    const backend = new GmailApiBackend({ creds: CREDS, fetchImpl });
    const list = await backend.listMessages('is:unread newer_than:1d', 20);
    expect(list).toEqual([{ id: 'm1', threadId: 't1' }]);
    const url = new URL(seen[1]!.url);
    expect(url.searchParams.get('q')).toBe('is:unread newer_than:1d');
    expect(url.searchParams.get('maxResults')).toBe('20');
  });

  it('send() posts base64url MIME with threading', async () => {
    const { fetchImpl, seen } = scriptedFetch([TOKEN_OK, () => jsonResponse({ id: 'sent1', threadId: 't1' })]);
    const backend = new GmailApiBackend({ creds: CREDS, fetchImpl });
    const id = await backend.send({
      to: 'alice@example.com',
      subject: 'Re: Q3 report',
      body: 'On it.',
      inReplyTo: '<abc123@mail.example.com>',
      threadId: 't1',
    });
    expect(id).toBe('sent1');
    const body = JSON.parse(seen[1]!.init.body as string) as { raw: string; threadId: string };
    expect(body.threadId).toBe('t1');
    const mime = base64urlDecode(body.raw);
    expect(mime).toContain('To: alice@example.com');
    expect(mime).toContain('In-Reply-To: <abc123@mail.example.com>');
    expect(mime).toContain('On it.');
  });

  it('markRead removes the UNREAD label', async () => {
    const { fetchImpl, seen } = scriptedFetch([TOKEN_OK, () => jsonResponse({})]);
    const backend = new GmailApiBackend({ creds: CREDS, fetchImpl });
    await backend.markRead('m1');
    expect(seen[1]!.url).toContain('/messages/m1/modify');
    expect(JSON.parse(seen[1]!.init.body as string)).toEqual({ removeLabelIds: ['UNREAD'] });
  });

  it('refreshes the token on a 401 and retries once', async () => {
    const { fetchImpl, seen } = scriptedFetch([
      TOKEN_OK, // initial token
      () => jsonResponse({ error: { message: 'expired' } }, 401), // list fails
      () => jsonResponse({ access_token: 'tok456', expires_in: 3600 }), // refresh
      () => jsonResponse({ messages: [] }), // retry succeeds
    ]);
    const backend = new GmailApiBackend({ creds: CREDS, fetchImpl });
    const list = await backend.listMessages('is:unread');
    expect(list).toEqual([]);
    const tokenCalls = seen.filter((s) => s.url.includes('oauth2.googleapis.com/token'));
    expect(tokenCalls).toHaveLength(2);
  });

  it('surfaces refresh failures without leaking secrets', async () => {
    const { fetchImpl } = scriptedFetch([
      () => jsonResponse({ error: 'invalid_grant', error_description: 'Token revoked' }, 400),
    ]);
    const backend = new GmailApiBackend({ creds: CREDS, fetchImpl });
    await expect(backend.profile()).rejects.toThrow(/token refresh failed/);
    await expect(backend.profile()).rejects.toThrow(/Token revoked/);
  });

  it('rejects empty recipients', async () => {
    const { fetchImpl } = scriptedFetch([TOKEN_OK]);
    const backend = new GmailApiBackend({ creds: CREDS, fetchImpl });
    await expect(backend.send({ to: '  ', subject: 'x', body: 'y' })).rejects.toThrow(/"to" is required/);
  });
});
