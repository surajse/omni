// OAuth 1.0a request signing (RFC 5849), HMAC-SHA1, hand-rolled with
// node:crypto — zero dependencies. Used for the X API v2. Secrets are never
// logged; only the Authorization header value is returned to the caller.
import { createHmac, randomBytes } from 'node:crypto';

export interface OAuth1Params {
  /** HTTP method, e.g. "GET" or "POST". */
  method: string;
  /** Full request URL (may include a query string). */
  url: string;
  /**
   * Extra parameters to include in the signature base string (query params
   * for GET, form-encoded body params for POST). JSON bodies are NOT signed.
   */
  params?: Record<string, string>;
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
  /** Injectable for deterministic tests. */
  nonce?: string;
  /** Injectable for deterministic tests (seconds since epoch). */
  timestamp?: string;
}

/** RFC 5849 percent-encoding: encodeURIComponent plus !'()*. */
export function pctEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Build the `Authorization: OAuth …` header value for a request.
 * Throws when any credential is missing.
 */
export function oauth1AuthorizationHeader(p: OAuth1Params): string {
  for (const [k, v] of [
    ['consumerKey', p.consumerKey],
    ['consumerSecret', p.consumerSecret],
    ['token', p.token],
    ['tokenSecret', p.tokenSecret],
  ] as const) {
    if (!v) throw new Error(`oauth1AuthorizationHeader: ${k} is required`);
  }
  const method = p.method.toUpperCase();
  const url = new URL(p.url);
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;

  const pairs: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => pairs.push([key, value]));
  for (const [k, v] of Object.entries(p.params ?? {})) pairs.push([k, v]);

  const oauth: Array<[string, string]> = [
    ['oauth_consumer_key', p.consumerKey],
    ['oauth_nonce', p.nonce ?? randomBytes(16).toString('hex')],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', p.timestamp ?? Math.floor(Date.now() / 1000).toString()],
    ['oauth_token', p.token],
    ['oauth_version', '1.0'],
  ];
  for (const pair of oauth) pairs.push(pair);

  const encoded = pairs.map(([k, v]) => [pctEncode(k), pctEncode(v)] as [string, string]);
  encoded.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const paramString = encoded.map(([k, v]) => `${k}=${v}`).join('&');
  const baseString = `${method}&${pctEncode(baseUrl)}&${pctEncode(paramString)}`;
  const signingKey = `${pctEncode(p.consumerSecret)}&${pctEncode(p.tokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

  const headerParams: Array<[string, string]> = [...oauth, ['oauth_signature', signature]];
  headerParams.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return 'OAuth ' + headerParams.map(([k, v]) => `${pctEncode(k)}="${pctEncode(v)}"`).join(', ');
}
