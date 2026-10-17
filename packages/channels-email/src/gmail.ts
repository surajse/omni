// GmailApiBackend: pure-HTTPS access to the Gmail REST API v1, zero external
// dependencies. Deliberately NOT hand-rolled IMAP (error-prone); the Gmail
// API is the honest, supported path (see docs/CHANNELS.md for setup).
//
// Auth is OAuth2: client id + secret + a long-lived refresh token from env.
// Access tokens are refreshed automatically and never logged.
export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface ParsedEmail {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  /** The RFC Message-ID header (for In-Reply-To threading). */
  messageId: string;
  /** Plain-text body (best effort; '' when none found). */
  body: string;
  snippet: string;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  body: string;
  /** RFC Message-ID of the message being answered (threading). */
  inReplyTo?: string;
  /** Space-joined Message-IDs for the References header. */
  references?: string;
  /** Gmail thread id to append to. */
  threadId?: string;
}

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Refresh a minute before the reported expiry to avoid boundary races. */
const TOKEN_SKEW_MS = 60_000;
/** Cap fetched message bodies at 256 KiB before handing to the agent. */
export const MAX_BODY_CHARS = 256 * 1024;

/** base64url without padding. */
export function base64urlEncode(input: string | Buffer): string {
  const b = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

/** Encode a header value when it contains non-ASCII (RFC 2047). */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Extract the bare address from a From header like `Name <a@b.c>`. */
export function extractEmailAddress(from: string): string {
  const m = /<([^<>@\s]+@[^<>@\s]+)>/.exec(from);
  if (m) return m[1]!;
  const bare = from.trim().match(/^[^<>\s]+@[^<>\s]+$/);
  return bare ? bare[0] : from.trim();
}

/** Build a minimal RFC822 message (text/plain, UTF-8). */
export function buildMime(params: SendEmailParams): string {
  const lines = [
    `To: ${params.to}`,
    `Subject: ${encodeHeaderValue(params.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (params.inReplyTo) lines.push(`In-Reply-To: ${params.inReplyTo}`);
  if (params.references) lines.push(`References: ${params.references}`);
  lines.push('', params.body);
  return lines.join('\r\n');
}

interface GmailPayloadPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPayloadPart[];
}

interface GmailMessageFull {
  id?: string;
  threadId?: string;
  snippet?: string;
  payload?: GmailPayloadPart;
}

/** Depth-first search for the first text/plain part that is not an attachment. */
function findPlainText(part: GmailPayloadPart | undefined): string | null {
  if (!part) return null;
  const isAttachment = !!part.filename || !!part.body?.attachmentId;
  if (!isAttachment && part.mimeType === 'text/plain' && part.body?.data) {
    return part.body.data;
  }
  for (const child of part.parts ?? []) {
    const found = findPlainText(child);
    if (found) return found;
  }
  return null;
}

/** Parse a `messages.get format=full` response into a ParsedEmail. */
export function parseGmailMessage(raw: GmailMessageFull): ParsedEmail {
  const headers = new Map<string, string>();
  for (const h of raw.payload?.headers ?? []) {
    if (h.name) headers.set(h.name.toLowerCase(), h.value ?? '');
  }
  const encodedBody = findPlainText(raw.payload);
  let body = '';
  if (encodedBody) {
    try {
      body = base64urlDecode(encodedBody);
    } catch {
      body = '';
    }
  }
  if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS) + '\n[…truncated]';
  return {
    id: String(raw.id ?? ''),
    threadId: String(raw.threadId ?? ''),
    from: headers.get('from') ?? '',
    subject: headers.get('subject') ?? '(no subject)',
    date: headers.get('date') ?? '',
    messageId: headers.get('message-id') ?? '',
    body,
    snippet: raw.snippet ?? '',
  };
}

export interface GmailApiBackendOptions {
  creds: GmailCredentials;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class GmailApiBackend {
  private readonly creds: GmailCredentials;
  private readonly fetchImpl: typeof fetch;
  private accessToken: string | null = null;
  private expiresAtMs = 0;

  constructor(opts: GmailApiBackendOptions) {
    for (const [k, v] of [
      ['clientId', opts.creds.clientId],
      ['clientSecret', opts.creds.clientSecret],
      ['refreshToken', opts.creds.refreshToken],
    ] as const) {
      if (!v) throw new Error(`GmailApiBackend: ${k} is required`);
    }
    this.creds = opts.creds;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Authenticated profile — also the credential check on channel start(). */
  async profile(): Promise<{ emailAddress: string }> {
    const res = await this.request('GET', '/users/me/profile');
    const email = (res as { emailAddress?: unknown }).emailAddress;
    if (typeof email !== 'string' || !email) {
      throw new Error('Gmail profile: no emailAddress in response');
    }
    return { emailAddress: email };
  }

  /** List message ids matching a Gmail search query (newest first). */
  async listMessages(
    query: string,
    maxResults = 20,
  ): Promise<Array<{ id: string; threadId: string }>> {
    const res = (await this.request('GET', '/users/me/messages', {
      query: { q: query, maxResults: String(Math.min(Math.max(maxResults, 1), 100)) },
    })) as { messages?: Array<{ id?: string; threadId?: string }> };
    return (res.messages ?? [])
      .filter((m) => typeof m.id === 'string')
      .map((m) => ({ id: m.id as string, threadId: String(m.threadId ?? '') }));
  }

  /** Fetch and parse one full message. */
  async getMessage(id: string): Promise<ParsedEmail> {
    const res = (await this.request('GET', `/users/me/messages/${encodeURIComponent(id)}`, {
      query: { format: 'full' },
    })) as GmailMessageFull;
    return parseGmailMessage(res);
  }

  /** Remove the UNREAD label (agent has handled it). */
  async markRead(id: string): Promise<void> {
    await this.request('POST', `/users/me/messages/${encodeURIComponent(id)}/modify`, {
      json: { removeLabelIds: ['UNREAD'] },
    });
  }

  /** Send an email; returns the Gmail message id. */
  async send(params: SendEmailParams): Promise<string> {
    if (!params.to.trim()) throw new Error('Gmail send: "to" is required');
    const raw = base64urlEncode(buildMime(params));
    const res = (await this.request('POST', '/users/me/messages/send', {
      json: { raw, ...(params.threadId ? { threadId: params.threadId } : {}) },
    })) as { id?: unknown };
    if (typeof res.id !== 'string' || !res.id) throw new Error('Gmail send: no message id in response');
    return res.id;
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAtMs - TOKEN_SKEW_MS) {
      return this.accessToken;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.creds.clientId,
          client_secret: this.creds.clientSecret,
          refresh_token: this.creds.refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      });
    } catch (err) {
      throw new Error(`Gmail token refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const data = (await res.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
      error_description?: unknown;
    } | null;
    if (!res.ok || typeof data?.access_token !== 'string') {
      // Never include the secret/refresh token in the error.
      throw new Error(
        `Gmail token refresh failed: HTTP ${res.status}${data?.error_description ? ` — ${String(data.error_description)}` : ''}`,
      );
    }
    this.accessToken = data.access_token;
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    this.expiresAtMs = Date.now() + expiresIn * 1000;
    return this.accessToken;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts: { query?: Record<string, string>; json?: unknown } = {},
    retried = false,
  ): Promise<unknown> {
    const token = await this.ensureToken();
    const url = new URL(GMAIL_BASE + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), { method, headers, body });
    } catch (err) {
      throw new Error(`Gmail ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 401 && !retried) {
      // Token may have expired early — force a refresh and retry once.
      this.accessToken = null;
      return this.request(method, path, opts, true);
    }
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = (data as { error?: { message?: unknown } } | null)?.error?.message;
      throw new Error(`Gmail ${method} ${path} failed: HTTP ${res.status}${detail ? ` — ${String(detail)}` : ''}`);
    }
    return data;
  }
}
