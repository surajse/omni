// WhatsAppCloudChannel: Channel over the Meta WhatsApp Business Cloud API.
// Runs a small node:http webhook server: GET verifies the webhook
// (hub.verify_token), POST receives inbound text messages and replies via the
// Graph API. Tokens are never logged.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Channel } from '@omni/channels';

export interface WhatsAppChannelOptions {
  /** WhatsApp Business phone number id (from the Meta developer dashboard). */
  phoneNumberId: string;
  /** Permanent/system-user access token. Passed via env WHATSAPP_TOKEN. */
  accessToken: string;
  /** The verify token you configured on the webhook. Passed via env WHATSAPP_VERIFY_TOKEN. */
  verifyToken: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface InboundTextMessage {
  from: string;
  body: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Extract text messages from a WhatsApp webhook payload, defensively. */
function extractTextMessages(body: unknown): InboundTextMessage[] {
  const out: InboundTextMessage[] = [];
  if (typeof body !== 'object' || body === null) return out;
  const entries = (body as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: unknown })?.value as
        | { messages?: unknown[] }
        | undefined;
      if (!Array.isArray(value?.messages)) continue;
      for (const m of value.messages) {
        const msg = m as { from?: unknown; type?: unknown; text?: { body?: unknown } };
        if (msg.type === 'text' && typeof msg.from === 'string' && typeof msg.text?.body === 'string') {
          out.push({ from: msg.from, body: msg.text.body });
        }
      }
    }
  }
  return out;
}

export class WhatsAppCloudChannel implements Channel {
  readonly id = 'whatsapp';
  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly verifyToken: string;
  private readonly fetchImpl: typeof fetch;
  private handler: ((text: string) => Promise<string | void>) | null = null;
  private server: Server | null = null;
  /** Last inbound sender; used as the reply recipient. */
  private recipient: string | null = null;

  constructor(opts: WhatsAppChannelOptions) {
    if (!opts.phoneNumberId) throw new Error('WhatsAppCloudChannel: phoneNumberId is required');
    if (!opts.accessToken) throw new Error('WhatsAppCloudChannel: accessToken is required');
    if (!opts.verifyToken) throw new Error('WhatsAppCloudChannel: verifyToken is required');
    this.phoneNumberId = opts.phoneNumberId;
    this.accessToken = opts.accessToken;
    this.verifyToken = opts.verifyToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  onMessage(handler: (text: string) => Promise<string | void>): void {
    this.handler = handler;
  }

  /** Override the reply recipient (defaults to the last inbound sender). */
  setRecipient(phone: string): void {
    this.recipient = phone;
  }

  async send(text: string): Promise<void> {
    const to = this.recipient;
    if (!to) {
      throw new Error('WhatsAppCloudChannel: no recipient — wait for an inbound message or call setRecipient()');
    }
    const res = await this.fetchImpl(
      `https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text },
        }),
      },
    );
    if (!res.ok) throw new Error(`WhatsApp send failed: HTTP ${res.status}`);
  }

  /**
   * Start the webhook server. Resolves once listening (differs from console/
   * telegram channels, whose start() resolves on stop); call stop() to close.
   */
  async start(port?: number): Promise<void> {
    const listenPort = port ?? Number(process.env['WHATSAPP_PORT'] ?? 3000);
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      this.server.once('error', reject);
      this.server.listen(listenPort, () => resolve());
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  /** Actual TCP port (useful with port 0 in tests). */
  listeningPort(): number | null {
    const addr = this.server?.address();
    return typeof addr === 'object' && addr !== null ? addr.port : null;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET') {
        this.handleVerification(url.searchParams, res);
        return;
      }
      if (req.method === 'POST') {
        const raw = await readBody(req);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('OK'); // ack fast; Meta redelivers on slow responses
        await this.handleWebhook(raw);
        return;
      }
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
    } catch (err) {
      // Never leak tokens in error output.
      console.error(`whatsapp webhook error: ${err instanceof Error ? err.message : 'unknown'}`);
      try {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      } catch {
        // ignore secondary failure
      }
    }
  }

  private handleVerification(params: URLSearchParams, res: ServerResponse): void {
    const mode = params.get('hub.mode');
    const token = params.get('hub.verify_token');
    const challenge = params.get('hub.challenge') ?? '';
    if (mode === 'subscribe' && token === this.verifyToken) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(challenge);
    } else {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
    }
  }

  private async handleWebhook(raw: string): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return; // not JSON — ignore
    }
    for (const msg of extractTextMessages(body)) {
      if (!this.handler) return;
      this.recipient = msg.from;
      try {
        const reply = await this.handler(msg.body);
        if (typeof reply === 'string' && reply.length > 0) {
          await this.send(reply);
        }
      } catch (err) {
        console.error(`whatsapp handler error: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
  }
}
