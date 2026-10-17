import { describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from '../src/telegram.js';

interface TgUpdate {
  update_id: number;
  message?: { message_id: number; from?: { id: number }; chat: { id: number }; text?: string };
}

function parsedBody(init: Parameters<typeof fetch>[1]): unknown {
  const b = init?.body;
  return typeof b === 'string' && b.length > 0 ? (JSON.parse(b) as unknown) : null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function textUpdate(updateId: number, fromId: number, chatId: number, text: string): TgUpdate {
  return { update_id: updateId, message: { message_id: 1, from: { id: fromId }, chat: { id: chatId }, text } };
}

/** Run the channel: the mock stops it after `polls` getUpdates calls. Bounded — no busy loop. */
function pollingMock(
  onUpdate: (n: number) => TgUpdate[] | null,
  onSend: (url: string, body: unknown) => void,
  polls: number,
  stop: () => void | Promise<void>,
) {
  let n = 0;
  return vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url);
    if (u.includes('/getUpdates')) {
      n++;
      if (n >= polls) await stop();
      const updates = n <= polls ? onUpdate(n) : [];
      return jsonResponse({ ok: true, result: updates ?? [] });
    }
    onSend(u, parsedBody(init));
    return jsonResponse({ ok: true, result: true });
  });
}

describe('TelegramChannel', () => {
  it('requires a bot token', () => {
    expect(() => new TelegramChannel({ botToken: '' })).toThrow(/botToken is required/);
  });

  it('requires a handler before start', async () => {
    const ch = new TelegramChannel({ botToken: 'T' });
    await expect(ch.start()).rejects.toThrow(/onMessage handler/);
  });

  it('delivers an update to the handler and replies to the right chat', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    let ch: TelegramChannel;
    const fetchImpl = pollingMock(
      (n) => (n === 1 ? [textUpdate(7, 42, 100, 'hello bot')] : []),
      (url, body) => calls.push({ url, body }),
      3,
      () => void ch.stop(),
    );

    ch = new TelegramChannel({ botToken: 'TESTTOKEN', fetchImpl });
    const seen: string[] = [];
    ch.onMessage(async (t) => {
      seen.push(t);
      return `echo:${t}`;
    });
    await ch.start();

    expect(seen).toEqual(['hello bot']);
    expect(ch.boundChatId()).toBe(100);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.telegram.org/botTESTTOKEN/sendMessage');
    expect(calls[0]?.body).toMatchObject({ chat_id: 100, text: 'echo:hello bot' });
  });

  it('ignores users outside the allowlist', async () => {
    const sent: unknown[] = [];
    let ch: TelegramChannel;
    const fetchImpl = pollingMock(
      (n) => (n === 1 ? [textUpdate(9, 42, 100, 'intruder')] : []),
      (_url, body) => sent.push(body),
      3,
      () => void ch.stop(),
    );
    ch = new TelegramChannel({ botToken: 'T', allowedUserIds: [7], fetchImpl });
    const seen: string[] = [];
    ch.onMessage(async (t) => {
      seen.push(t);
    });
    await ch.start();
    expect(seen).toEqual([]);
    expect(sent).toEqual([]);
    expect(ch.boundChatId()).toBeNull();
  });

  it('send() before any inbound message throws', async () => {
    const ch = new TelegramChannel({ botToken: 'T' });
    await expect(ch.send('hi')).rejects.toThrow(/no chat bound/);
  });

  it('splits messages longer than the Telegram limit', async () => {
    const bodies: unknown[] = [];
    let ch: TelegramChannel;
    const fetchImpl = pollingMock(
      (n) => (n === 1 ? [textUpdate(11, 1, 55, 'go')] : []),
      (_url, body) => bodies.push(body),
      3,
      () => void ch.stop(),
    );
    ch = new TelegramChannel({ botToken: 'T', fetchImpl });
    ch.onMessage(async () => 'z'.repeat(9000));
    await ch.start();
    expect(bodies).toHaveLength(3);
    const texts = bodies.map((b) => (b as { text: string }).text);
    expect(texts.join('')).toBe('z'.repeat(9000));
    expect(Math.max(...texts.map((t) => t.length))).toBeLessThanOrEqual(4000);
  });

  it('requestApproval throws before any inbound message', async () => {
    const ch = new TelegramChannel({ botToken: 'T' });
    await expect(ch.requestApproval({ tool: 'x', args: {} })).rejects.toThrow(/no chat bound/);
  });
});

interface TgCallbackUpdate {
  update_id: number;
  callback_query: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

function callbackQueryUpdate(
  updateId: number,
  queryId: string,
  data: string,
  chatId: number,
  messageId: number,
): TgCallbackUpdate {
  return {
    update_id: updateId,
    callback_query: { id: queryId, data, message: { message_id: messageId, chat: { id: chatId } } },
  };
}

/** Extract the approval callback_data from a recorded sendMessage body. */
function approvalCallbackData(body: unknown): string {
  const b = body as {
    reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
  };
  const kb = b.reply_markup?.inline_keyboard?.[0] ?? [];
  const data = kb[0]?.callback_data ?? '';
  expect(data).toMatch(/^omni:(approve|deny):a\d+$/);
  return data;
}

describe('TelegramChannel inline approvals', () => {
  const TOKEN = 'SECRETTOKEN123';
  const hasKeyboard = (body: unknown): boolean =>
    (body as { reply_markup?: unknown } | null)?.reply_markup !== undefined;

  /** Drive: poll1 binds the chat and starts a run that requests approval;
   *  the first later poll where the approval message exists delivers the
   *  button tap; remaining polls drain. */
  async function driveApprovalTap(tap: 'approve' | 'deny'): Promise<{
    calls: Array<{ url: string; body: unknown }>;
    replies: string[];
  }> {
    const calls: Array<{ url: string; body: unknown }> = [];
    let ch: TelegramChannel;
    let tapDelivered = false;
    const fetchImpl = pollingMock(
      (n) => {
        if (n === 1) return [textUpdate(30, 42, 100, 'do the thing')];
        if (!tapDelivered) {
          const approvalCall = calls.find((c) => hasKeyboard(c.body));
          if (approvalCall) {
            tapDelivered = true;
            const data = approvalCallbackData(approvalCall.body).replace(
              /^omni:(approve|deny):/,
              `omni:${tap}:`,
            );
            return [callbackQueryUpdate(31, 'cq-1', data, 100, 9)];
          }
        }
        return [];
      },
      (url, body) => calls.push({ url, body }),
      8,
      () => void ch.stop(),
    );
    ch = new TelegramChannel({ botToken: TOKEN, fetchImpl });
    ch.onMessage(async () => {
      const ok = await ch.requestApproval({ tool: 'computer.exec', args: { command: 'ls' } });
      return ok ? 'was-approved' : 'was-denied';
    });
    await ch.start();
    const replies = calls
      .map((c) => (c.body as { text?: unknown }).text)
      .filter((t): t is string => typeof t === 'string');
    return { calls, replies };
  }

  it('sends the approval with an inline keyboard', async () => {
    const { calls } = await driveApprovalTap('approve');
    const approvalCall = calls.find((c) => hasKeyboard(c.body));
    expect(approvalCall?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = approvalCall?.body as {
      chat_id: number;
      parse_mode: string;
      reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
    expect(body.chat_id).toBe(100);
    expect(body.parse_mode).toBe('HTML');
    const buttons = body.reply_markup.inline_keyboard[0] ?? [];
    expect(buttons.map((b) => b.text)).toEqual(['✅ Approve', '❌ Deny']);
    // The token must never appear in any request body (it lives in the URL path only).
    for (const c of calls) expect(JSON.stringify(c.body)).not.toContain(TOKEN);
  });

  it('tapping Approve resolves true and edits the message', async () => {
    const { calls, replies } = await driveApprovalTap('approve');
    expect(replies).toContain('was-approved');
    const edit = calls.find((c) => c.url.includes('/editMessageText'));
    expect((edit?.body as { text: string }).text).toContain('Approved');
    expect((edit?.body as { text: string }).text).toContain('computer.exec');
    const answer = calls.find((c) => c.url.includes('/answerCallbackQuery'));
    expect((answer?.body as { text: string }).text).toBe('Approved');
  });

  it('tapping Deny resolves false and edits the message', async () => {
    const { calls, replies } = await driveApprovalTap('deny');
    expect(replies).toContain('was-denied');
    const edit = calls.find((c) => c.url.includes('/editMessageText'));
    expect((edit?.body as { text: string }).text).toContain('Denied');
  });

  it('answers unknown callback data without crashing', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    let ch: TelegramChannel;
    const fetchImpl = pollingMock(
      (n) => {
        if (n === 1) return [textUpdate(40, 42, 100, 'hi')];
        if (n === 2) return [callbackQueryUpdate(41, 'cq-x', 'unrelated-data', 100, 9)];
        return [];
      },
      (url, body) => calls.push({ url, body }),
      4,
      () => void ch.stop(),
    );
    ch = new TelegramChannel({ botToken: 'T', fetchImpl });
    const seen: string[] = [];
    ch.onMessage(async (t) => {
      seen.push(t);
      return 'ok';
    });
    await ch.start();
    expect(seen).toEqual(['hi']);
    expect(calls.some((c) => c.url.includes('/answerCallbackQuery'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/editMessageText'))).toBe(false);
  });

  it('stop() resolves pending approvals as denied', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    let ch: TelegramChannel;
    const fetchImpl = pollingMock(
      (n) => (n === 1 ? [textUpdate(50, 42, 100, 'go')] : []),
      (url, body) => calls.push({ url, body }),
      2, // stop fires on the second poll with no button tap
      () => ch.stop(),
    );
    ch = new TelegramChannel({ botToken: 'T', fetchImpl });
    ch.onMessage(async () => {
      const ok = await ch.requestApproval({ tool: 'computer.exec', args: {} });
      return ok ? 'was-approved' : 'was-denied';
    });
    await ch.start();
    const replies = calls
      .map((c) => (c.body as { text?: unknown }).text)
      .filter((t): t is string => typeof t === 'string');
    expect(replies).toContain('was-denied');
    expect(ch.pendingApprovalCount()).toBe(0);
  });
});

describe('TelegramChannel voice', () => {
  interface VoiceTgUpdate {
    update_id: number;
    message?: {
      message_id: number;
      from?: { id: number };
      chat: { id: number };
      text?: string;
      voice?: { file_id: string };
      audio?: { file_id: string };
    };
  }

  function voiceUpdate(updateId: number, chatId: number, fileId: string): VoiceTgUpdate {
    return { update_id: updateId, message: { message_id: 1, from: { id: 42 }, chat: { id: chatId }, voice: { file_id: fileId } } };
  }

  /** Mock fetch serving: getUpdates, getFile, file download, sendAudio/sendMessage. */
  function voiceMock(opts: {
    updates: VoiceTgUpdate[];
    audioBytes: Buffer;
    onSendAudio: (body: Buffer, contentType: string) => void;
    onSendMessage: (body: unknown) => void;
    stop: () => void | Promise<void>;
  }) {
    let polls = 0;
    return async (url: string, init?: { body?: unknown; headers?: Record<string, string> }) => {
      const u = String(url);
      if (u.includes('/getUpdates')) {
        polls++;
        if (polls >= 2) await opts.stop();
        return { ok: true, status: 200, json: async () => ({ ok: true, result: polls === 1 ? opts.updates : [] }) } as Response;
      }
      if (u.includes('/getFile')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: 'voice/f1.ogg' } }) } as Response;
      }
      if (u.includes('/file/bot')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => opts.audioBytes.buffer.slice(opts.audioBytes.byteOffset, opts.audioBytes.byteOffset + opts.audioBytes.byteLength),
        } as unknown as Response;
      }
      if (u.includes('/sendAudio')) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        opts.onSendAudio(init?.body as Buffer, headers['content-type'] ?? '');
        return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) } as Response;
      }
      opts.onSendMessage(typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) } as Response;
    };
  }

  it('transcribes a voice message and replies with audio when configured', async () => {
    const sttCalls: Array<{ bytes: Buffer; filename: string }> = [];
    const ttsCalls: string[] = [];
    const sentAudio: Array<{ body: Buffer; contentType: string }> = [];
    const sentMessages: unknown[] = [];
    let ch: TelegramChannel;
    const fetchImpl = voiceMock({
      updates: [voiceUpdate(7, 100, 'file_abc')],
      audioBytes: Buffer.from([10, 20, 30]),
      onSendAudio: (body, contentType) => sentAudio.push({ body, contentType }),
      onSendMessage: (body) => sentMessages.push(body),
      stop: () => ch.stop(),
    }) as unknown as typeof fetch;

    ch = new TelegramChannel({
      botToken: 'T',
      fetchImpl,
      voice: {
        stt: async (audio, filename) => {
          sttCalls.push({ bytes: audio, filename });
          return 'transcribed hello';
        },
        tts: async (text) => {
          ttsCalls.push(text);
          return Buffer.from([1, 2, 3]);
        },
        replyWithAudio: true,
      },
    });
    const seen: string[] = [];
    ch.onMessage(async (t) => {
      seen.push(t);
      return 'reply text here';
    });
    await ch.start();

    expect(seen).toEqual(['transcribed hello']);
    expect(sttCalls).toHaveLength(1);
    expect(sttCalls[0]!.bytes).toEqual(Buffer.from([10, 20, 30]));
    expect(ttsCalls).toEqual(['reply text here']);
    expect(sentAudio).toHaveLength(1);
    expect(sentAudio[0]!.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const multipart = sentAudio[0]!.body.toString('latin1');
    expect(multipart).toContain('name="audio"; filename="reply.mp3"');
    expect(multipart).toContain('name="caption"');
    expect(multipart).toContain('reply text here');
    expect(sentMessages).toHaveLength(0);
  });

  it('replies with text when replyWithAudio is off', async () => {
    const sentMessages: unknown[] = [];
    const sentAudio: Array<{ body: Buffer; contentType: string }> = [];
    let ch: TelegramChannel;
    const fetchImpl = voiceMock({
      updates: [voiceUpdate(8, 100, 'file_def')],
      audioBytes: Buffer.from([5]),
      onSendAudio: (body, contentType) => sentAudio.push({ body, contentType }),
      onSendMessage: (body) => sentMessages.push(body),
      stop: () => ch.stop(),
    }) as unknown as typeof fetch;

    ch = new TelegramChannel({
      botToken: 'T',
      fetchImpl,
      voice: { stt: async () => 'hi there' },
    });
    ch.onMessage(async (t) => `echo:${t}`);
    await ch.start();

    expect(sentAudio).toHaveLength(0);
    expect(sentMessages).toHaveLength(1);
    expect((sentMessages[0] as { text?: string }).text).toBe('echo:hi there');
  });

  it('politely declines voice when not configured', async () => {
    const sentMessages: unknown[] = [];
    let ch: TelegramChannel;
    const fetchImpl = voiceMock({
      updates: [voiceUpdate(9, 100, 'file_ghi')],
      audioBytes: Buffer.from([5]),
      onSendAudio: () => {},
      onSendMessage: (body) => sentMessages.push(body),
      stop: () => ch.stop(),
    }) as unknown as typeof fetch;

    ch = new TelegramChannel({ botToken: 'T', fetchImpl });
    ch.onMessage(async () => 'should not be called');
    await ch.start();

    expect(sentMessages).toHaveLength(1);
    expect((sentMessages[0] as { text?: string }).text).toMatch(/not enabled/);
  });
});
