// XChannel: Channel over the X API v2, watching mentions and replying in
// thread. OAuth 1.0a (user context) signs every request — hand-rolled in
// ./oauth1.js. Credentials come from env (see docs/CHANNELS.md) and are
// never logged.
//
// Automation rules apply: only reply to genuine mentions, keep replies
// useful, and respect rate limits. since_id tracking is in-memory — a
// restart may re-see the most recent mentions (documented in CHANNELS.md).
import type { Channel } from '@omni/channels';
import { oauth1AuthorizationHeader } from './oauth1.js';

export interface XChannelOptions {
  /** X API key (consumer key). */
  consumerKey: string;
  /** X API key secret (consumer secret). */
  consumerSecret: string;
  /** User access token. */
  accessToken: string;
  /** User access token secret. */
  accessTokenSecret: string;
  /** Mentions poll interval. Defaults to 120_000 ms. */
  pollIntervalMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface XSearchResult {
  id: string;
  text: string;
  authorId?: string;
  createdAt?: string;
}

interface XMention {
  id: string;
  text: string;
  author_id?: string;
}

const API_BASE = 'https://api.x.com/2';
/** X post length limit for a single tweet. */
const MAX_TWEET_LENGTH = 280;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Tweet ids are numeric snowflakes — compare as BigInt, fall back to string. */
function maxId(a: string | null, b: string): string {
  if (a === null) return b;
  try {
    return BigInt(b) > BigInt(a) ? b : a;
  } catch {
    return b > a ? b : a;
  }
}

export class XChannel implements Channel {
  readonly id = 'x';
  private readonly consumerKey: string;
  private readonly consumerSecret: string;
  private readonly accessToken: string;
  private readonly accessTokenSecret: string;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private handler: ((text: string) => Promise<string | void>) | null = null;
  private running = false;
  private myUserId: string | null = null;
  /** Newest mention id seen so far (in-memory). */
  private sinceId: string | null = null;
  /** Tweet id the current reply threads to (set during mention handling). */
  private replyToTweetId: string | null = null;

  constructor(opts: XChannelOptions) {
    for (const [k, v] of [
      ['consumerKey', opts.consumerKey],
      ['consumerSecret', opts.consumerSecret],
      ['accessToken', opts.accessToken],
      ['accessTokenSecret', opts.accessTokenSecret],
    ] as const) {
      if (!v) throw new Error(`XChannel: ${k} is required`);
    }
    this.consumerKey = opts.consumerKey;
    this.consumerSecret = opts.consumerSecret;
    this.accessToken = opts.accessToken;
    this.accessTokenSecret = opts.accessTokenSecret;
    this.pollIntervalMs = opts.pollIntervalMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? sleep;
  }

  onMessage(handler: (text: string) => Promise<string | void>): void {
    this.handler = handler;
  }

  /** Own X user id, resolved on start(). */
  ownUserId(): string | null {
    return this.myUserId;
  }

  /** Post a standalone tweet (not a reply). */
  async send(text: string): Promise<void> {
    const trimmed = text.length > MAX_TWEET_LENGTH ? text.slice(0, MAX_TWEET_LENGTH - 1) + '…' : text;
    const res = await this.request('POST', '/tweets', { json: { text: trimmed } });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`X post tweet failed: HTTP ${res.status}`);
    }
  }

  /**
   * Bulk search recent posts (X API v2 `tweets/search/recent`, OAuth 1.0a
   * signed). Returns newest-first results; on a 429 the retry-after backoff
   * is honored once before giving up.
   */
  async search(query: string, opts: { maxResults?: number } = {}): Promise<XSearchResult[]> {
    if (!query.trim()) throw new Error('X search: query must be non-empty');
    const maxResults = Math.min(Math.max(Math.floor(opts.maxResults ?? 10), 1), 100);
    const params = {
      query,
      max_results: String(maxResults),
      'tweet.fields': 'created_at,author_id',
    };
    let res = await this.request('GET', '/tweets/search/recent', { query: params });
    if (res.status === 429) {
      const retryAfterMs = Math.min(Number(res.headers.get('retry-after') ?? '60') * 1000, 15 * 60_000);
      console.error(`x search rate limited (429); backing off ${Math.round(retryAfterMs / 1000)}s`);
      await this.sleepImpl(retryAfterMs);
      res = await this.request('GET', '/tweets/search/recent', { query: params });
    }
    if (res.status === 429) throw new Error('X search failed: rate limited (429) after backoff');
    if (res.status !== 200) throw new Error(`X search failed: HTTP ${res.status}`);
    const body = (res.json ?? {}) as {
      data?: Array<{ id: string; text: string; author_id?: string; created_at?: string }>;
    };
    return (body.data ?? []).map((t) => ({
      id: t.id,
      text: t.text,
      authorId: t.author_id,
      createdAt: t.created_at,
    }));
  }

  /** Start polling mentions. Resolves when stop() is called. */
  async start(): Promise<void> {
    if (!this.handler) throw new Error('XChannel: onMessage handler must be set before start()');
    const me = await this.request('GET', '/users/me');
    if (me.status !== 200) throw new Error(`X /users/me failed: HTTP ${me.status}`);
    const uid = (me.json as { data?: { id?: unknown } } | null)?.data?.id;
    if (typeof uid !== 'string' || !uid) throw new Error('X /users/me: no user id in response');
    this.myUserId = uid;
    this.running = true;
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        // Never crash the loop on a failed poll; credentials stay out of logs.
        console.error(`x poll error: ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.sleepImpl(this.pollIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts: { query?: Record<string, string>; json?: unknown } = {},
  ): Promise<{ status: number; headers: Headers; json: unknown }> {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = {
      authorization: oauth1AuthorizationHeader({
        method,
        url: url.toString(),
        consumerKey: this.consumerKey,
        consumerSecret: this.consumerSecret,
        token: this.accessToken,
        tokenSecret: this.accessTokenSecret,
      }),
    };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    const res = await this.fetchImpl(url.toString(), { method, headers, body });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, headers: res.headers, json: data };
  }

  private async pollOnce(): Promise<void> {
    if (!this.myUserId) return;
    const query: Record<string, string> = {
      'tweet.fields': 'conversation_id,author_id',
      expansions: 'author_id',
      'user.fields': 'username',
      max_results: '10',
    };
    if (this.sinceId) query['since_id'] = this.sinceId;
    const res = await this.request('GET', `/users/${this.myUserId}/mentions`, { query });
    if (res.status === 429) {
      const retryAfterMs = Math.min(Number(res.headers.get('retry-after') ?? '60') * 1000, 15 * 60_000);
      console.error(`x rate limited (429); backing off ${Math.round(retryAfterMs / 1000)}s`);
      await this.sleepImpl(retryAfterMs);
      return;
    }
    if (res.status !== 200) throw new Error(`X mentions failed: HTTP ${res.status}`);
    const body = (res.json ?? {}) as {
      data?: XMention[];
      includes?: { users?: Array<{ id: string; username?: string }> };
      meta?: { newest_id?: string };
    };
    // API returns newest-first; handle oldest-first so replies stay ordered.
    const tweets = [...(body.data ?? [])].reverse();
    const usernames = new Map<string, string>();
    for (const u of body.includes?.users ?? []) {
      if (u.username) usernames.set(u.id, u.username);
    }
    for (const tweet of tweets) {
      this.sinceId = maxId(this.sinceId, tweet.id);
      await this.handleMention(tweet);
    }
    if (body.meta?.newest_id) this.sinceId = maxId(this.sinceId, body.meta.newest_id);
  }

  private async handleMention(tweet: XMention): Promise<void> {
    if (!this.handler) return;
    if (tweet.author_id === this.myUserId) return; // never reply to self
    this.replyToTweetId = tweet.id;
    try {
      const reply = await this.handler(tweet.text);
      if (typeof reply === 'string' && reply.length > 0) {
        await this.replyToTweet(tweet.id, reply);
      }
    } catch (err) {
      console.error(`x mention handler error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.replyToTweetId = null;
    }
  }

  private async replyToTweet(tweetId: string, text: string): Promise<void> {
    const trimmed = text.length > MAX_TWEET_LENGTH ? text.slice(0, MAX_TWEET_LENGTH - 1) + '…' : text;
    const res = await this.request('POST', '/tweets', {
      json: { text: trimmed, reply: { in_reply_to_tweet_id: tweetId } },
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`X post reply failed: HTTP ${res.status}`);
    }
  }
}
