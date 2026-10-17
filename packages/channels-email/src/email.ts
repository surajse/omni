// EmailChannel: Channel over email, backed by the Gmail REST API.
// Inbound: polls for unread messages (configurable Gmail search query),
// parses From/Subject/body, and dispatches each new message to the agent.
// Handled messages are marked read (configurable). Outbound: the agent's
// reply is sent as a threaded email reply (In-Reply-To / References).
// Credentials come from env (see docs/CHANNELS.md) and are never logged.
// Seen message ids are in-memory — a restart may re-see recent mail
// (documented in CHANNELS.md).
import type { Channel } from '@omni/channels';
import { GmailApiBackend, extractEmailAddress, type GmailCredentials } from './gmail.js';

export interface EmailChannelOptions {
  creds: GmailCredentials;
  /** Poll interval. Defaults to 5 minutes. */
  pollIntervalMs?: number;
  /** Gmail search query. Defaults to unread mail from the last day. */
  query?: string;
  /** Mark handled messages read. Defaults to true. */
  markRead?: boolean;
  /** Max messages fetched per poll. Defaults to 20. */
  maxResults?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export const DEFAULT_EMAIL_QUERY = 'is:unread newer_than:1d';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class EmailChannel implements Channel {
  readonly id = 'email';
  private readonly backend: GmailApiBackend;
  private readonly pollIntervalMs: number;
  private readonly query: string;
  private readonly markRead: boolean;
  private readonly maxResults: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private handler: ((text: string) => Promise<string | void>) | null = null;
  private running = false;
  private myEmail = '';
  private readonly seen = new Set<string>();
  /** Most recent inbound message, for send() and reply threading. */
  private lastFrom = '';
  private lastSubject = '';
  private lastMessageId = '';
  private lastThreadId = '';
  private lastReferences = '';

  constructor(opts: EmailChannelOptions) {
    this.backend = new GmailApiBackend({ creds: opts.creds, fetchImpl: opts.fetchImpl });
    this.pollIntervalMs = opts.pollIntervalMs ?? 5 * 60_000;
    this.query = opts.query ?? DEFAULT_EMAIL_QUERY;
    this.markRead = opts.markRead ?? true;
    this.maxResults = opts.maxResults ?? 20;
    this.sleepImpl = opts.sleepImpl ?? sleep;
  }

  onMessage(handler: (text: string) => Promise<string | void>): void {
    this.handler = handler;
  }

  /** The authenticated Gmail address (resolved on start()). */
  ownEmail(): string {
    return this.myEmail;
  }

  /**
   * Reply to the most recent inbound email (threaded). Needs at least one
   * received message first — same binding pattern as the Slack channel.
   */
  async send(text: string): Promise<void> {
    if (!this.lastFrom) {
      throw new Error('EmailChannel: no message received yet — send() needs an inbound email first');
    }
    await this.backend.send({
      to: extractEmailAddress(this.lastFrom),
      subject: this.lastSubject.startsWith('Re:') ? this.lastSubject : `Re: ${this.lastSubject}`,
      body: text,
      inReplyTo: this.lastMessageId || undefined,
      references: this.lastReferences || undefined,
      threadId: this.lastThreadId || undefined,
    });
  }

  /** Start polling. Resolves when stop() is called. */
  async start(): Promise<void> {
    if (!this.handler) throw new Error('EmailChannel: onMessage handler must be set before start()');
    const profile = await this.backend.profile();
    this.myEmail = profile.emailAddress.toLowerCase();
    this.running = true;
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        // Never crash the loop on a failed poll; credentials stay out of logs.
        console.error(`email poll error: ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.sleepImpl(this.pollIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async pollOnce(): Promise<void> {
    const messages = await this.backend.listMessages(this.query, this.maxResults);
    // The API returns newest-first; handle oldest-first so order is natural.
    for (const m of [...messages].reverse()) {
      if (this.seen.has(m.id)) continue;
      this.seen.add(m.id);
      const email = await this.backend.getMessage(m.id);
      await this.handleEmail(email);
    }
  }

  private async handleEmail(email: {
    id: string;
    from: string;
    subject: string;
    date: string;
    messageId: string;
    body: string;
    snippet: string;
    threadId: string;
  }): Promise<void> {
    if (!this.handler) return;
    // Never answer our own sent mail (or mail already in the thread from us).
    const sender = extractEmailAddress(email.from).toLowerCase();
    if (sender && sender === this.myEmail) return;
    this.lastFrom = email.from;
    this.lastSubject = email.subject;
    this.lastMessageId = email.messageId;
    this.lastThreadId = email.threadId;
    this.lastReferences = [email.messageId].filter(Boolean).join(' ');
    const text = `From: ${email.from}\nSubject: ${email.subject}\nDate: ${email.date}\n\n${email.body || email.snippet}`;
    try {
      const reply = await this.handler(text);
      if (typeof reply === 'string' && reply.length > 0) {
        await this.send(reply);
      }
      if (this.markRead) {
        await this.backend.markRead(email.id);
      }
    } catch (err) {
      console.error(`email handler error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
