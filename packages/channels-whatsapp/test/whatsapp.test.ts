import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppCloudChannel } from '../src/whatsapp.js';

const OPTS = { phoneNumberId: 'PNID123', accessToken: 'TOKEN', verifyToken: 's3cret' };

let channels: WhatsAppCloudChannel[] = [];
afterEach(async () => {
  for (const c of channels) await c.stop().catch(() => {});
  channels = [];
});

function track(ch: WhatsAppCloudChannel): WhatsAppCloudChannel {
  channels.push(ch);
  return ch;
}

function parsedBody(init: Parameters<typeof fetch>[1]): unknown {
  const b = init?.body;
  return typeof b === 'string' && b.length > 0 ? (JSON.parse(b) as unknown) : null;
}

function authHeader(init: Parameters<typeof fetch>[1]): string | null {
  const h = init?.headers as Record<string, string> | undefined;
  return h?.['authorization'] ?? null;
}

function inboundPayload(from: string, body: string): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ from, id: 'wamid.1', timestamp: '1', type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
}

describe('WhatsAppCloudChannel', () => {
  it('rejects missing options', () => {
    expect(() => new WhatsAppCloudChannel({ ...OPTS, phoneNumberId: '' })).toThrow(/phoneNumberId/);
    expect(() => new WhatsAppCloudChannel({ ...OPTS, accessToken: '' })).toThrow(/accessToken/);
    expect(() => new WhatsAppCloudChannel({ ...OPTS, verifyToken: '' })).toThrow(/verifyToken/);
  });

  it('answers the webhook verification handshake', async () => {
    const ch = track(new WhatsAppCloudChannel(OPTS));
    await ch.start(0);
    const port = ch.listeningPort();
    expect(port).toBeGreaterThan(0);
    const ok = await fetch(
      `http://127.0.0.1:${port}/?hub.mode=subscribe&hub.verify_token=s3cret&hub.challenge=CHAL`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('CHAL');
    const bad = await fetch(
      `http://127.0.0.1:${port}/?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=CHAL`,
    );
    expect(bad.status).toBe(403);
  });

  it('routes an inbound message to the handler and replies via the Graph API', async () => {
    const graphCalls: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const fetchImpl = vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      graphCalls.push({
        url: String(url),
        body: parsedBody(init),
        auth: authHeader(init),
      });
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const ch = track(new WhatsAppCloudChannel({ ...OPTS, fetchImpl }));
    const seen: string[] = [];
    ch.onMessage(async (t) => {
      seen.push(t);
      return `wa:${t}`;
    });
    await ch.start(0);
    const port = ch.listeningPort()!;

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(inboundPayload('15551234567', 'ping')),
    });
    expect(res.status).toBe(200);
    // The ack is sent before async processing; poll briefly for the Graph call.
    for (let i = 0; i < 50 && graphCalls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen).toEqual(['ping']);
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0]?.url).toBe('https://graph.facebook.com/v21.0/PNID123/messages');
    expect(graphCalls[0]?.body).toMatchObject({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'text',
      text: { body: 'wa:ping' },
    });
    expect(graphCalls[0]?.auth).toBe('Bearer TOKEN');
  });

  it('ignores non-text messages and statuses without crashing', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
    const ch = track(new WhatsAppCloudChannel({ ...OPTS, fetchImpl }));
    const seen: string[] = [];
    ch.onMessage(async (t) => {
      seen.push(t);
    });
    await ch.start(0);
    const port = ch.listeningPort()!;
    const payload = {
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }],
    };
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('send() with an explicit recipient works without inbound traffic', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      bodies.push(parsedBody(init));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const ch = track(new WhatsAppCloudChannel({ ...OPTS, fetchImpl }));
    ch.setRecipient('19998887777');
    await ch.send('proactive');
    expect(bodies[0]).toMatchObject({ to: '19998887777', text: { body: 'proactive' } });
  });

  it('send() without a recipient throws', async () => {
    const ch = track(new WhatsAppCloudChannel(OPTS));
    await expect(ch.send('hi')).rejects.toThrow(/no recipient/);
  });
});
