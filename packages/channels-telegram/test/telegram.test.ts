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
  stop: () => void,
) {
  let n = 0;
  return vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url);
    if (u.includes('/getUpdates')) {
      n++;
      if (n >= polls) stop();
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
});
