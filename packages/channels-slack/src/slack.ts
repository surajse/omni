// SlackChannel: Channel over the Slack Events API.
// Inbound: an node:http webhook receiver verifies every request with the
// app's signing secret (HMAC-SHA256, `v0=` scheme, 5-minute timestamp
// tolerance), answers `url_verification` challenges, and routes
// `app_mention` + human `message` events to the agent. Outbound: replies go
// through `chat.postMessage`, threaded on the incoming message.
// Credentials come from env (see docs/CHANNELS.md) and are never logged.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Channel } from '@omni/channels';

export interface SlackChannelOptions {
  /** Bot token (`xoxb-…`). */
  botToken: string;
  /** App signing secret (for X-Slack-Signature verification). */
  signingSecret: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (epoch seconds) for tests. */
  nowSec?: () => number;
}

/** Slack rejects (and we reject) signatures older than 5 minutes. */
const SIGNATURE_TOLERANCE_SEC = 5 * 60;
/** Cap inbound webhook bodies at 1 MiB. */
const MAX_BODY_BYTES = 1024 * 1024;

export function verifySlackSignature(args: {
  signingSecret: string;
  timestamp: string;
  body: string;
  signature: string;
  nowSec?: () => number;
}): boolean {
  const ts = Number(args.timestamp);
  const now = args.nowSec ? args.nowSec() : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNATURE_TOLERANCE_SEC) return false;
  const base = `v0:${args.timestamp}:${args.body}`;
  const expected = 'v0=' + createHmac('sha256', args.signingSecret).update(base, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(args.signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Strip a leading `<@USERID>` mention so the agent sees plain text. */
export function stripMention(text: string): string {
  return text.replace(/^<@[A-Z0-9]+>\s*/, '');
}

interface SlackEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
}

export class SlackChannel implements Channel {
  readonly id = 'slack';
  private readonly botToken: string;
  private readonly signingSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowSec?: () => number;
  private handler: ((text: string) => Promise<string | void>) | null = null;
  private server: Server | null = null;
  private botUserId: string | null = null;
  /** Channel/thread of the most recent inbound message (for send()). */
  private lastChannel: string | null = null;
  private lastThreadTs: string | null = null;

  constructor(opts: SlackChannelOptions) {
    if (!opts.botToken) throw new Error('SlackChannel: botToken is required');
    if (!opts.signingSecret) throw new Error('SlackChannel: signingSecret is required');
    this.botToken = opts.botToken;
    this.signingSecret = opts.signingSecret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.nowSec = opts.nowSec;
  }

  onMessage(handler: (text: string) => Promise<string | void>): void {
    this.handler = handler;
  }

  /** The port the webhook server is actually listening on (null when stopped). */
  localPort(): number | null {
    const addr = this.server?.address();
    return typeof addr === 'object' && addr ? addr.port : null;
  }

  /** Post to the channel/thread of the most recent inbound message. */
  async send(text: string): Promise<void> {
    if (!this.lastChannel) {
      throw new Error('SlackChannel: no channel bound yet — send() needs an incoming message first');
    }
    await this.postMessage(this.lastChannel, text, this.lastThreadTs);
  }

  /**
   * Resolve the bot's own user id (for self-message filtering) and start the
   * webhook server. Resolves once listening — the process stays alive until
   * stop() (the CLI holds it open like the WhatsApp channel).
   */
  async start(port = 3000): Promise<void> {
    if (!this.handler) throw new Error('SlackChannel: onMessage handler must be set before start()');
    const me = await this.api('auth.test', {});
    if (typeof me.user_id !== 'string' || !me.user_id) {
      throw new Error('Slack auth.test: no user_id in response — is SLACK_BOT_TOKEN valid?');
    }
    this.botUserId = me.user_id;
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, () => resolve());
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async api(
    method: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string; user_id?: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The token is only ever sent as an Authorization header; never logged.
          authorization: `Bearer ${this.botToken}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Slack ${method} request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      user_id?: string;
    } | null;
    if (!res.ok || !data?.ok) {
      throw new Error(`Slack ${method} failed: ${data?.error ?? `HTTP ${res.status}`}`);
    }
    return { ok: true, user_id: data.user_id };
  }

  private async postMessage(channel: string, text: string, threadTs: string | null): Promise<void> {
    await this.api('chat.postMessage', {
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end('method not allowed');
      return;
    }
    let body: string;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch {
      res.writeHead(413).end('body too large');
      return;
    }
    const signature = req.headers['x-slack-signature'];
    const timestamp = req.headers['x-slack-request-timestamp'];
    if (
      typeof signature !== 'string' ||
      typeof timestamp !== 'string' ||
      !verifySlackSignature({
        signingSecret: this.signingSecret,
        timestamp,
        body,
        signature,
        nowSec: this.nowSec,
      })
    ) {
      res.writeHead(401).end('invalid signature');
      return;
    }
    let payload: { type?: string; challenge?: string; event?: SlackEvent };
    try {
      payload = JSON.parse(body) as { type?: string; challenge?: string; event?: SlackEvent };
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }
    if (payload.type === 'url_verification') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(payload.challenge ?? '');
      return;
    }
    // Acknowledge immediately (Slack requires <3s); process async.
    res.writeHead(200).end('ok');
    if (payload.type === 'event_callback' && payload.event) {
      await this.handleEvent(payload.event);
    }
  }

  private async handleEvent(event: SlackEvent): Promise<void> {
    if (event.type === 'app_mention') {
      this.bind(event);
      await this.dispatch(stripMention(event.text ?? ''));
      return;
    }
    if (event.type === 'message') {
      // Ignore bot messages, edits, deletes, joins — only fresh human text.
      if (event.subtype || event.bot_id) return;
      if (event.user === this.botUserId) return;
      this.bind(event);
      await this.dispatch(event.text ?? '');
    }
  }

  private bind(event: SlackEvent): void {
    if (event.channel) this.lastChannel = event.channel;
    this.lastThreadTs = event.thread_ts ?? event.ts ?? null;
  }

  private async dispatch(text: string): Promise<void> {
    if (!this.handler || !this.lastChannel) return;
    try {
      const reply = await this.handler(text);
      if (typeof reply === 'string' && reply.length > 0) {
        await this.postMessage(this.lastChannel, reply, this.lastThreadTs);
      }
    } catch (err) {
      // Never crash the webhook on a handler failure; secrets stay out of logs.
      console.error(`slack handler error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
