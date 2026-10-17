// Browser backend over CDP: open pages, read them as accessibility trees
// (the agent's "eyes"), click and type by AX node id, take screenshots.
import type { CdpConnection } from './cdp.js';
import { connectCdp, resolveCdpWebSocketUrl } from './cdp.js';

export interface BrowserBackend {
  open(url: string): Promise<void>;
  /** The page as a pruned accessibility tree: `[nodeId] role "name"`. */
  snapshot(): Promise<string>;
  click(nodeId: string): Promise<void>;
  type(nodeId: string, text: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  backendDOMNodeId?: number;
}

/** Snapshot caps keep the agent's context small. */
const MAX_SNAPSHOT_NODES = 200;
const MAX_SNAPSHOT_CHARS = 8000;

export class CdpBrowserBackend implements BrowserBackend {
  private readonly conn: CdpConnection;
  private readonly loadTimeoutMs: number;
  /** AX nodeId -> backendDOMNodeId, rebuilt by every snapshot(). */
  private readonly nodeMap = new Map<string, number>();

  constructor(conn: CdpConnection, opts: { loadTimeoutMs?: number } = {}) {
    this.conn = conn;
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 30_000;
  }

  /** Connect to a CDP endpoint (`ws://…` or `http://host:9222`) and enable the Page + Accessibility domains. */
  static async connect(
    cdpUrl: string,
    opts: { loadTimeoutMs?: number; timeoutMs?: number } = {},
  ): Promise<CdpBrowserBackend> {
    const wsUrl = await resolveCdpWebSocketUrl(cdpUrl);
    const conn = await connectCdp(wsUrl, { timeoutMs: opts.timeoutMs });
    const backend = new CdpBrowserBackend(conn, opts);
    await conn.send('Page.enable');
    await conn.send('Accessibility.enable');
    return backend;
  }

  async open(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`browser.open: not a valid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`browser.open: only http(s) URLs are allowed (got ${parsed.protocol})`);
    }
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`browser.open: page load timed out for ${url}`));
      }, this.loadTimeoutMs);
      const off = this.conn.on('Page.loadEventFired', () => {
        clearTimeout(timer);
        off();
        resolve();
      });
    });
    const nav = (await this.conn.send('Page.navigate', { url })) as { errorText?: string } | null;
    if (nav?.errorText) {
      throw new Error(`browser.open: navigation failed: ${nav.errorText}`);
    }
    await loaded;
  }

  async snapshot(): Promise<string> {
    const res = (await this.conn.send('Accessibility.getFullAXTree', {})) as { nodes?: AxNode[] } | null;
    const lines: string[] = [];
    this.nodeMap.clear();
    for (const n of res?.nodes ?? []) {
      if (lines.length >= MAX_SNAPSHOT_NODES) break;
      if (n.ignored) continue;
      const role = n.role?.value ?? 'unknown';
      const label = [n.name?.value ?? '', n.value?.value ?? ''].filter(Boolean).join(' = ');
      if (n.backendDOMNodeId !== undefined) this.nodeMap.set(n.nodeId, n.backendDOMNodeId);
      lines.push(`[${n.nodeId}] ${role}${label ? ` "${label}"` : ''}`);
    }
    const text = lines.join('\n');
    return text.length > MAX_SNAPSHOT_CHARS ? text.slice(0, MAX_SNAPSHOT_CHARS) + '\n…(truncated)' : text;
  }

  async click(nodeId: string): Promise<void> {
    const objectId = await this.resolveObjectId(nodeId);
    await this.conn.send('DOM.scrollIntoViewIfNeeded', { objectId });
    const res = (await this.conn.send('DOM.getContentQuads', { objectId })) as { quads?: number[] } | null;
    const quads = res?.quads;
    if (!quads || quads.length < 8) {
      throw new Error(`browser.click: node "${nodeId}" has no visible box`);
    }
    const x = (quads[0]! + quads[2]! + quads[4]! + quads[6]!) / 4;
    const y = (quads[1]! + quads[3]! + quads[5]! + quads[7]!) / 4;
    await this.conn.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await this.conn.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  async type(nodeId: string, text: string): Promise<void> {
    if (!text) throw new Error('browser.type: text must be non-empty');
    const objectId = await this.resolveObjectId(nodeId);
    await this.conn.send('DOM.focus', { objectId });
    await this.conn.send('Input.insertText', { text });
  }

  async screenshot(): Promise<Buffer> {
    const res = (await this.conn.send('Page.captureScreenshot', { format: 'png' })) as {
      data?: string;
    } | null;
    if (typeof res?.data !== 'string' || res.data.length === 0) {
      throw new Error('browser: screenshot returned no data');
    }
    return Buffer.from(res.data, 'base64');
  }

  async close(): Promise<void> {
    this.conn.close();
  }

  private async resolveObjectId(nodeId: string): Promise<string> {
    const backendNodeId = this.nodeMap.get(nodeId);
    if (backendNodeId === undefined) {
      throw new Error(`browser: unknown node "${nodeId}" — take a fresh browser.snapshot first`);
    }
    const res = (await this.conn.send('DOM.resolveNode', { backendNodeId })) as {
      object?: { objectId?: string };
    } | null;
    const objectId = res?.object?.objectId;
    if (!objectId) {
      throw new Error(`browser: could not resolve node "${nodeId}" to a DOM object`);
    }
    return objectId;
  }
}
