// TelegramChannel: Channel over the Telegram Bot API using long-polling
// (getUpdates). No webhook server needed — works behind NAT. The bot token is
// never logged. Optional voice support: inbound voice/audio messages are
// transcribed to text; replies can go back as audio.
import { randomBytes } from 'node:crypto';
import type { Channel } from '@omni/channels';

/** Voice hooks: injectable so the CLI can wire real @omni/voice clients. */
export interface VoiceHooks {
  /** Transcribe audio bytes (ogg/mp3/…) to text. */
  stt: (audio: Buffer, filename: string) => Promise<string>;
  /** Synthesize reply audio. Required for replyWithAudio. */
  tts?: (text: string) => Promise<Buffer>;
  /** When true and the trigger was a voice message, reply with sendAudio. */
  replyWithAudio?: boolean;
}

export interface TelegramChannelOptions {
  /** Bot token from @BotFather. Passed via env TELEGRAM_BOT_TOKEN in the CLI. */
  botToken: string;
  /** Telegram user ids allowed to talk to the agent. Omit to allow everyone. */
  allowedUserIds?: number[];
  /** Voice hooks (STT/TTS). Omit to disable voice messages. */
  voice?: VoiceHooks;
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
    voice?: { file_id: string; duration?: number };
    audio?: { file_id: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

/** A tool-call approval request surfaced as inline buttons. */
export interface TelegramApprovalRequest {
  tool: string;
  args: Record<string, unknown>;
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
  chatId: number;
  messageId: number;
  tool: string;
}

const MAX_MESSAGE_LENGTH = 4000;
/** Telegram caption limit for audio messages. */
const MAX_CAPTION_LENGTH = 1024;

/** Escape text for Telegram's HTML parse mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
  private readonly voice?: VoiceHooks;
  private readonly fetchImpl: typeof fetch;
  private handler: ((text: string) => Promise<string | void>) | null = null;
  private chatId: number | null = null;
  private running = false;
  private offset = 0;
  private approvalSeq = 0;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  /** Message handlers currently running; stop() waits for them. */
  private readonly inflight = new Set<Promise<void>>();
  /** Set when stop() begins; late approval requests resolve false immediately. */
  private stopping = false;

  constructor(opts: TelegramChannelOptions) {
    if (!opts.botToken) throw new Error('TelegramChannel: botToken is required');
    this.botToken = opts.botToken;
    this.allowedUserIds = opts.allowedUserIds;
    this.voice = opts.voice;
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
    this.stopping = true;
    // A stopped channel must not leave runs hanging on approvals.
    for (const [, pending] of this.pendingApprovals) pending.resolve(false);
    this.pendingApprovals.clear();
    // Wait for in-flight message handlers (they may be awaiting approvals).
    await Promise.allSettled([...this.inflight]);
  }

  /**
   * Ask the Telegram user to approve a tool call. Sends the question with
   * inline Approve/Deny buttons and resolves when the user taps one.
   * Wire this into the agent's approve callback for Telegram-originated runs.
   */
  async requestApproval(req: TelegramApprovalRequest): Promise<boolean> {
    if (this.chatId === null) {
      throw new Error('TelegramChannel: no chat bound yet — requestApproval needs an incoming message first');
    }
    const approvalId = `a${++this.approvalSeq}`;
    const argsJson = JSON.stringify(req.args, null, 2).slice(0, 1500);
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: `Approve tool call?\n<b>${escapeHtml(req.tool)}</b>\n<pre>${escapeHtml(argsJson)}</pre>`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve', callback_data: `omni:approve:${approvalId}` },
              { text: '❌ Deny', callback_data: `omni:deny:${approvalId}` },
            ],
          ],
        },
      }),
    });
    if (!res.ok) throw new Error(`Telegram sendMessage failed: HTTP ${res.status}`);
    const data = (await res.json()) as { result?: { message_id?: number } };
    const messageId = data.result?.message_id ?? 0;
    const chatId = this.chatId;
    return new Promise<boolean>((resolve) => {
      // If stop() already began, never leave the caller hanging.
      if (this.stopping) {
        resolve(false);
        return;
      }
      this.pendingApprovals.set(approvalId, { resolve, chatId, messageId, tool: req.tool });
    });
  }

  /** Pending approvals (for inspection/debugging). */
  pendingApprovalCount(): number {
    return this.pendingApprovals.size;
  }

  private async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  }

  private async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/editMessageText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }),
    });
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }
    const msg = update.message;
    if (!msg || !this.handler) return;
    const fromId = msg.from?.id;
    if (this.allowedUserIds && (fromId === undefined || !this.allowedUserIds.includes(fromId))) {
      return; // silently ignore users outside the allowlist
    }
    this.chatId = msg.chat.id;
    if (msg.text) {
      // Fire-and-forget: the handler may block on requestApproval(), which needs
      // the poll loop to keep running so the user's button tap can arrive.
      // stop() waits for in-flight handlers, so shutdown stays clean.
      this.track(this.handleMessage(msg.text, false));
      return;
    }
    const voiceFileId = msg.voice?.file_id ?? msg.audio?.file_id;
    if (voiceFileId) {
      this.track(this.handleVoiceMessage(voiceFileId));
    }
  }

  /** Track an in-flight message handler so stop() can wait for it. */
  private track(task: Promise<void>): void {
    this.inflight.add(task);
    task.then(
      () => this.inflight.delete(task),
      (err: unknown) => {
        this.inflight.delete(task);
        console.error(`telegram message handler error: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  }

  private async handleMessage(text: string, viaVoice: boolean): Promise<void> {
    const reply = await this.handler?.(text);
    if (typeof reply === 'string' && reply.length > 0) {
      if (viaVoice && this.voice?.replyWithAudio && this.voice.tts) {
        await this.sendAudio(await this.voice.tts(reply), reply);
      } else {
        await this.send(reply);
      }
    }
  }

  /** Download a voice/audio message, transcribe it, and handle it as text. */
  private async handleVoiceMessage(fileId: string): Promise<void> {
    if (!this.voice?.stt) {
      await this.send('🎙️ Voice messages are not enabled for this bot yet.');
      return;
    }
    const audio = await this.downloadFile(fileId);
    const text = await this.voice.stt(audio, 'voice.ogg');
    await this.handleMessage(text, true);
  }

  /** getFile → download bytes from the Telegram file endpoint. */
  private async downloadFile(fileId: string): Promise<Buffer> {
    const res = await this.fetchImpl(
      `https://api.telegram.org/bot${this.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
    );
    if (!res.ok) throw new Error(`Telegram getFile failed: HTTP ${res.status}`);
    const data = (await res.json()) as { ok: boolean; result?: { file_path?: string } };
    const filePath = data.result?.file_path;
    if (!filePath) throw new Error('Telegram getFile: no file_path in response');
    const dl = await this.fetchImpl(`https://api.telegram.org/file/bot${this.botToken}/${filePath}`);
    if (!dl.ok) throw new Error(`Telegram file download failed: HTTP ${dl.status}`);
    return Buffer.from(await dl.arrayBuffer());
  }

  /** Send an audio reply (multipart) with the text as caption. */
  private async sendAudio(audio: Buffer, caption: string): Promise<void> {
    if (this.chatId === null) {
      throw new Error('TelegramChannel: no chat bound yet — sendAudio needs an incoming message first');
    }
    const boundary = '----omni' + randomBytes(16).toString('hex');
    const cap = caption.length > MAX_CAPTION_LENGTH ? caption.slice(0, MAX_CAPTION_LENGTH - 1) + '…' : caption;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${this.chatId}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="reply.mp3"\r\n` +
        `Content-Type: audio/mpeg\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${cap}\r\n--${boundary}--\r\n`);
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendAudio`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([head, audio, tail]),
    });
    if (!res.ok) throw new Error(`Telegram sendAudio failed: HTTP ${res.status}`);
  }

  private async handleCallbackQuery(
    query: NonNullable<TgUpdate['callback_query']>,
  ): Promise<void> {
    const match = /^omni:(approve|deny):([A-Za-z0-9]+)$/.exec(query.data ?? '');
    if (!match) {
      await this.answerCallback(query.id);
      return;
    }
    const approved = match[1] === 'approve';
    const pending = this.pendingApprovals.get(match[2] ?? '');
    if (pending) {
      this.pendingApprovals.delete(match[2] ?? '');
      pending.resolve(approved);
      await this.editMessage(
        pending.chatId,
        pending.messageId,
        approved
          ? `✅ Approved: <b>${escapeHtml(pending.tool)}</b>`
          : `❌ Denied: <b>${escapeHtml(pending.tool)}</b>`,
      );
    }
    await this.answerCallback(query.id, approved ? 'Approved' : 'Denied');
  }
}
