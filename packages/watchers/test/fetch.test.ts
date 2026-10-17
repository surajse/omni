import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchTarget, normalizeText } from '../src/fetch.js';

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function serveText(text: string, status = 200): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(text);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      servers.push(server);
      resolve(`http://127.0.0.1:${port}/`);
    });
  });
}

describe('fetchTarget', () => {
  it('reads a file target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-watch-'));
    const file = join(dir, 'note.txt');
    writeFileSync(file, '  hello   world\n');
    expect(await fetchTarget({ kind: 'file', ref: file })).toBe('hello world');
  });

  it('fails clearly on a missing file', async () => {
    await expect(fetchTarget({ kind: 'file', ref: '/no/such/file.txt' })).rejects.toThrow();
  });

  it('runs a command target', async () => {
    expect(await fetchTarget({ kind: 'command', ref: 'echo hello' })).toBe('hello');
  });

  it('fails clearly on a bad command', async () => {
    await expect(fetchTarget({ kind: 'command', ref: 'exit 3' })).rejects.toThrow(/command failed/);
  });

  it('fetches a url target', async () => {
    const url = await serveText('  price:   $42\n');
    expect(await fetchTarget({ kind: 'url', ref: url })).toBe('price: $42');
  });

  it('fails clearly on a bad status', async () => {
    const url = await serveText('nope', 500);
    await expect(fetchTarget({ kind: 'url', ref: url })).rejects.toThrow(/500/);
  });
});

describe('normalizeText', () => {
  it('collapses whitespace', () => {
    expect(normalizeText('a\n\n  b\tc')).toBe('a b c');
  });
});
