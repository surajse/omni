import { describe, expect, it } from 'vitest';
import { CdpBrowserBackend } from '../src/backend.js';
import type { CdpConnection } from '../src/cdp.js';

/** Stub CDP connection: canned responses, inspectable calls, drivable events. */
class StubConn implements CdpConnection {
  calls: Array<{ method: string; params: unknown }> = [];
  respond: (method: string, params: Record<string, unknown>) => unknown = () => ({});
  private readonly subs = new Map<string, Array<(p: Record<string, unknown>) => void>>();
  closed = false;

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    return this.respond(method, params);
  }
  on(method: string, handler: (p: Record<string, unknown>) => void): () => void {
    const arr = this.subs.get(method) ?? [];
    arr.push(handler);
    this.subs.set(method, arr);
    return () => {
      this.subs.set(method, (this.subs.get(method) ?? []).filter((h) => h !== handler));
    };
  }
  fire(method: string, params: Record<string, unknown> = {}): void {
    for (const h of this.subs.get(method) ?? []) h(params);
  }
  close(): void {
    this.closed = true;
  }
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

const AX_TREE = {
  nodes: [
    { nodeId: '1', role: { value: 'heading' }, name: { value: 'Example Domain' }, backendDOMNodeId: 11 },
    { nodeId: '2', ignored: true, role: { value: 'none' } },
    {
      nodeId: '3',
      role: { value: 'link' },
      name: { value: 'More information' },
      backendDOMNodeId: 33,
    },
    {
      nodeId: '4',
      role: { value: 'textbox' },
      name: { value: 'Search' },
      value: { value: '' },
      backendDOMNodeId: 44,
    },
  ],
};

function backendWith(respond: StubConn['respond'], loadTimeoutMs = 1000): { conn: StubConn; backend: CdpBrowserBackend } {
  const conn = new StubConn();
  conn.respond = respond;
  return { conn, backend: new CdpBrowserBackend(conn, { loadTimeoutMs }) };
}

describe('CdpBrowserBackend.open', () => {
  it('navigates and waits for the load event', async () => {
    const { conn, backend } = backendWith((method) => {
      if (method === 'Page.navigate') {
        queueMicrotask(() => conn.fire('Page.loadEventFired'));
      }
      return {};
    });
    await backend.open('https://example.com');
    expect(conn.methods()).toContain('Page.navigate');
    expect(conn.calls.find((c) => c.method === 'Page.navigate')?.params).toMatchObject({
      url: 'https://example.com',
    });
  });

  it('rejects non-http(s) URLs and garbage', async () => {
    const { backend } = backendWith(() => ({}));
    await expect(backend.open('ftp://example.com/x')).rejects.toThrow(/only http\(s\)/);
    await expect(backend.open('not a url')).rejects.toThrow(/not a valid URL/);
  });

  it('surfaces navigation errors', async () => {
    const { backend } = backendWith((method) =>
      method === 'Page.navigate' ? { errorText: 'net::ERR_NAME_NOT_RESOLVED' } : {},
    );
    await expect(backend.open('https://nope.invalid')).rejects.toThrow(/navigation failed/);
  });

  it('times out when the load event never fires', async () => {
    const { backend } = backendWith(() => ({}), 20);
    await expect(backend.open('https://example.com')).rejects.toThrow(/load timed out/);
  });
});

describe('CdpBrowserBackend.snapshot', () => {
  it('returns a pruned AX tree and skips ignored nodes', async () => {
    const { backend } = backendWith((method) => (method === 'Accessibility.getFullAXTree' ? AX_TREE : {}));
    const snap = await backend.snapshot();
    expect(snap).toBe('[1] heading "Example Domain"\n[3] link "More information"\n[4] textbox "Search"');
    expect(snap).not.toContain('none');
  });

  it('truncates very long trees', async () => {
    const nodes = Array.from({ length: 500 }, (_, i) => ({
      nodeId: String(i),
      role: { value: 'text' },
      name: { value: `node number ${i} with a reasonably long accessible name` },
      backendDOMNodeId: i,
    }));
    const { backend } = backendWith(() => ({ nodes }));
    const snap = await backend.snapshot();
    expect(snap.length).toBeLessThanOrEqual(8100);
    expect(snap).toContain('(truncated)');
  });
});

describe('CdpBrowserBackend.click/type', () => {
  it('click dispatches press+release at the quad center', async () => {
    const { conn, backend } = backendWith((method) => {
      if (method === 'Accessibility.getFullAXTree') return AX_TREE;
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-33' } };
      if (method === 'DOM.getContentQuads') return { quads: [10, 20, 30, 20, 30, 40, 10, 40] };
      return {};
    });
    await backend.snapshot(); // populates the node map
    await backend.click('3');
    const mouse = conn.calls.filter((c) => c.method === 'Input.dispatchMouseEvent');
    expect(mouse).toHaveLength(2);
    expect(mouse[0]!.params).toMatchObject({ type: 'mousePressed', x: 20, y: 30, button: 'left' });
    expect(mouse[1]!.params).toMatchObject({ type: 'mouseReleased', x: 20, y: 30, button: 'left' });
  });

  it('click on an unknown node tells the agent to re-snapshot', async () => {
    const { backend } = backendWith(() => ({}));
    await expect(backend.click('99')).rejects.toThrow(/fresh browser\.snapshot/);
  });

  it('type focuses the node and inserts text', async () => {
    const { conn, backend } = backendWith((method) => {
      if (method === 'Accessibility.getFullAXTree') return AX_TREE;
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-44' } };
      return {};
    });
    await backend.snapshot();
    await backend.type('4', 'hello');
    expect(conn.calls.find((c) => c.method === 'DOM.focus')?.params).toMatchObject({
      objectId: 'obj-44',
    });
    expect(conn.calls.find((c) => c.method === 'Input.insertText')?.params).toMatchObject({
      text: 'hello',
    });
  });

  it('type rejects empty text', async () => {
    const { backend } = backendWith(() => ({}));
    await expect(backend.type('4', '')).rejects.toThrow(/non-empty/);
  });
});

describe('CdpBrowserBackend.screenshot/close', () => {
  it('decodes base64 PNG bytes', async () => {
    const raw = Buffer.from('fakepng').toString('base64');
    const { backend } = backendWith((method) =>
      method === 'Page.captureScreenshot' ? { data: raw } : {},
    );
    const buf = await backend.screenshot();
    expect(buf.toString()).toBe('fakepng');
  });

  it('close closes the connection', async () => {
    const { conn, backend } = backendWith(() => ({}));
    await backend.close();
    expect(conn.closed).toBe(true);
  });
});
