// TelegramChannel: Channel over the Telegram Bot API using long-polling
// (getUpdates). No webhook server needed — works behind NAT. The bot token is
// never logged.
import type { Channel } from '@omni/channels';

export interface TelegramChannelOptions {
  /** Bot token from @BotFather. Passed via env TELEGRAM_BOT_TOKEN in the CLI. */
  botToken: string;
  /** Telegram user ids allowed to talk to the agent. Omit to allow everyone. */
  allowedUserIds?: number[];
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number };
    chat: { id: number };
    text?: string;
  };
}

const MAX_MESSAGE_LENGTH = 4000;

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max) chunks.push(text.slice(i, i + max));
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class TelegramChannel implements Channel {
  readonly id = 'telegram';
  private readonly botToken: string;
  private readonly allowedUserIds?: number[];
  private readonly fetchImpl: typeof fetch;
  private handler: ((text: string) => Promise<string | void>) | null = null;
  private chatId: number | null = null;
  private running = false;
  private offset = 0;

  constructor(opts: TelegramChannelOptions) {
    if (!opts.botToken) throw new Error('TelegramChannel: botToken is required');
    this.botToken = opts.botToken;
    this.allowedUserIds = opts.allowedUserIds;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  onMessage(handler: (text: string) => Promise<string | void>): void {
    this.handler = handler;
  }

  /** The chat id bound from the most recent inbound message (null until then). */
  boundChatId(): number | null {
    return this.chatId;
  }

  async send(text: string): Promise<void> {
    if (this.chatId === null) {
      throw new Error('TelegramChannel: no chat bound yet — send() needs an incoming message first');
    }
    for (const chunk of chunkText(text, MAX_MESSAGE_LENGTH)) {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text: chunk }),
      });
      if (!res.ok) throw new Error(`Telegram sendMessage failed: HTTP ${res.status}`);
    }
  }

  /** Run the long-poll loop. Resolves when stop() is called. */
  async start(): Promise<void> {
    if (!this.handler) throw new Error('TelegramChannel: onMessage handler must be set before start()');
    this.running = true;
    let backoffMs = 1000;
    while (this.running) {
      try {
        const res = await this.fetchImpl(
          `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.offset}&timeout=30`,
        );
        if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`);
        const data = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
        backoffMs = 1000;
        for (const update of data.result ?? []) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (!this.running) break;
        // Never include the token in logs.
        console.error(`telegram poll error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.text || !this.handler) return;
    const fromId = msg.from?.id;
    if (this.allowedUserIds && (fromId === undefined || !this.allowedUserIds.includes(fromId))) {
      return; // silently ignore users outside the allowlist
    }
    this.chatId = msg.chat.id;
    const reply = await this.handler(msg.text);
    if (typeof reply === 'string' && reply.length > 0) {
      await this.send(reply);
    }
  }
}
