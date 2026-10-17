import { describe, expect, it } from 'vitest';
import { ToolGateway } from '@omni/kernel';
import { registerBrowserTools } from '../src/tools.js';
import type { BrowserBackend } from '../src/backend.js';

class FakeBackend implements BrowserBackend {
  calls: Array<{ op: string; args: unknown[] }> = [];
  snapshotText = '[1] heading "Hi"';
  async open(url: string): Promise<void> {
    this.calls.push({ op: 'open', args: [url] });
  }
  async snapshot(): Promise<string> {
    this.calls.push({ op: 'snapshot', args: [] });
    return this.snapshotText;
  }
  async click(nodeId: string): Promise<void> {
    this.calls.push({ op: 'click', args: [nodeId] });
  }
  async type(nodeId: string, text: string): Promise<void> {
    this.calls.push({ op: 'type', args: [nodeId, text] });
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
  async close(): Promise<void> {
    this.calls.push({ op: 'close', args: [] });
  }
}

describe('registerBrowserTools', () => {
  it('registers the four browser tools as write-class (policy ask by default)', () => {
    const gateway = new ToolGateway();
    registerBrowserTools(gateway, new FakeBackend());
    const defs = new Map(gateway.list().map((d) => [d.name, d]));
    for (const name of ['browser.open', 'browser.snapshot', 'browser.click', 'browser.type']) {
      const def = defs.get(name);
      expect(def, name).toBeDefined();
      expect(def!.readOnly, name).toBe(false);
    }
  });

  it('handlers delegate to the backend and validate args', async () => {
    const gateway = new ToolGateway();
    const backend = new FakeBackend();
    registerBrowserTools(gateway, backend);
    await expect(gateway.execute('browser.open', { url: 'https://example.com' })).resolves.toContain(
      'https://example.com',
    );
    await expect(gateway.execute('browser.snapshot', {})).resolves.toBe('[1] heading "Hi"');
    await expect(gateway.execute('browser.click', { node: '7' })).resolves.toContain('7');
    await expect(gateway.execute('browser.type', { node: '7', text: 'hi' })).resolves.toContain('7');
    await expect(gateway.execute('browser.open', {})).rejects.toThrow(/"url"/);
    await expect(gateway.execute('browser.click', {})).rejects.toThrow(/"node"/);
    await expect(gateway.execute('browser.type', { node: '7' })).rejects.toThrow(/"text"/);
    expect(backend.calls.map((c) => c.op)).toEqual(['open', 'snapshot', 'click', 'type']);
  });
});
