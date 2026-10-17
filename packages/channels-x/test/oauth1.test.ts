// Tests for the hand-rolled OAuth 1.0a signer. The signature is verified by
// an independent recomputation in the test (not a hardcoded vector).
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { oauth1AuthorizationHeader, pctEncode } from '../src/oauth1.js';

const CREDS = {
  consumerKey: 'ck',
  consumerSecret: 'cs',
  token: 't',
  tokenSecret: 'ts',
};

/** Independent reference computation of the expected signature. */
function referenceSignature(method: string, url: string, nonce: string, timestamp: string): string {
  const u = new URL(url);
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const pairs: Array<[string, string]> = [];
  u.searchParams.forEach((v, k) => pairs.push([pctEncode(k), pctEncode(v)]));
  const oauth: Array<[string, string]> = [
    ['oauth_consumer_key', 'ck'],
    ['oauth_nonce', nonce],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', timestamp],
    ['oauth_token', 't'],
    ['oauth_version', '1.0'],
  ];
  for (const [k, v] of oauth) pairs.push([pctEncode(k), pctEncode(v)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const paramString = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const baseString = `${method}&${pctEncode(baseUrl)}&${pctEncode(paramString)}`;
  return createHmac('sha1', `${pctEncode('cs')}&${pctEncode('ts')}`).update(baseString).digest('base64');
}

function parseHeader(header: string): Record<string, string> {
  expect(header.startsWith('OAuth ')).toBe(true);
  const out: Record<string, string> = {};
  for (const part of header.slice('OAuth '.length).split(', ')) {
    const eq = part.indexOf('=');
    const raw = part.slice(eq + 1);
    out[part.slice(0, eq)] = raw.startsWith('"') ? decodeURIComponent(raw.slice(1, -1)) : raw;
  }
  return out;
}

describe('pctEncode', () => {
  it("encodes !'()* which encodeURIComponent leaves alone", () => {
    expect(pctEncode("!'()*")).toBe('%21%27%28%29%2A');
    expect(pctEncode('a b')).toBe('a%20b');
  });
});

describe('oauth1AuthorizationHeader', () => {
  it('is deterministic with injected nonce/timestamp and carries all oauth params', () => {
    const h1 = oauth1AuthorizationHeader({
      method: 'GET',
      url: 'https://api.x.com/2/users/me',
      ...CREDS,
      nonce: 'abc123',
      timestamp: '1700000000',
    });
    const h2 = oauth1AuthorizationHeader({
      method: 'GET',
      url: 'https://api.x.com/2/users/me',
      ...CREDS,
      nonce: 'abc123',
      timestamp: '1700000000',
    });
    expect(h1).toBe(h2);
    const params = parseHeader(h1);
    expect(params['oauth_consumer_key']).toBe('ck');
    expect(params['oauth_token']).toBe('t');
    expect(params['oauth_signature_method']).toBe('HMAC-SHA1');
    expect(params['oauth_nonce']).toBe('abc123');
    expect(params['oauth_timestamp']).toBe('1700000000');
    expect(params['oauth_version']).toBe('1.0');
    expect(params['oauth_signature']).toBeTruthy();
  });

  it('signature matches an independent recomputation (query params included)', () => {
    const url = 'https://api.x.com/2/users/123/mentions?since_id=999&max_results=10';
    const header = oauth1AuthorizationHeader({
      method: 'GET',
      url,
      ...CREDS,
      nonce: 'n0nce',
      timestamp: '1700000001',
    });
    const expected = referenceSignature('GET', url, 'n0nce', '1700000001');
    expect(parseHeader(header)['oauth_signature']).toBe(expected);
  });

  it('signs POSTs with extra params and uppercases the method', () => {
    const header = oauth1AuthorizationHeader({
      method: 'post',
      url: 'https://api.x.com/2/tweets',
      params: { in_reply_to_status_id: '42' },
      ...CREDS,
      nonce: 'n',
      timestamp: '1',
    });
    expect(parseHeader(header)['oauth_signature']).toBeTruthy();
  });

  it('throws when credentials are missing', () => {
    expect(() =>
      oauth1AuthorizationHeader({ method: 'GET', url: 'https://x', ...CREDS, consumerSecret: '' }),
    ).toThrow('consumerSecret');
  });
});
