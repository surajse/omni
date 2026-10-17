import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listDocFiles, registerDocTools, resolveDocPath } from '../src/docs.js';
import { ToolGateway } from '../src/tools.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'omni-docs-'));
  const gateway = new ToolGateway();
  registerDocTools(gateway, dir);
  return { dir, gateway };
}

describe('resolveDocPath', () => {
  const root = '/tmp/omni-docs-root';

  it('resolves normal relative paths', () => {
    expect(resolveDocPath(root, 'a/b.md')).toBe(join(root, 'a/b.md'));
  });

  it('blocks traversal attacks', () => {
    expect(() => resolveDocPath(root, '../escape')).toThrow(/escapes/);
    expect(() => resolveDocPath(root, '../../etc/passwd')).toThrow(/escapes/);
    expect(() => resolveDocPath(root, '/etc/passwd')).toThrow(/escapes/);
    expect(() => resolveDocPath(root, 'a/../../escape')).toThrow(/escapes/);
  });

  it('rejects empty paths', () => {
    expect(() => resolveDocPath(root, '')).toThrow(/non-empty/);
    expect(() => resolveDocPath(root, '  ')).toThrow(/non-empty/);
  });
});

describe('doc tools', () => {
  it('write/read/append/list roundtrip', async () => {
    const { gateway } = setup();
    expect(gateway.has('doc.write')).toBe(true);
    expect(gateway.has('doc.read')).toBe(true);
    expect(gateway.has('doc.list')).toBe(true);
    expect(gateway.has('doc.append')).toBe(true);

    await gateway.execute('doc.write', { path: 'brief.md', content: '# Hello\n' });
    expect(await gateway.execute('doc.read', { path: 'brief.md' })).toBe('# Hello\n');
    await gateway.execute('doc.append', { path: 'brief.md', content: 'more\n' });
    expect(await gateway.execute('doc.read', { path: 'brief.md' })).toBe('# Hello\nmore\n');

    await gateway.execute('doc.write', { path: 'sub/note.md', content: 'x' });
    const list = await gateway.execute('doc.list', {});
    expect(list.split('\n').sort()).toEqual(['brief.md', 'sub/note.md']);
  });

  it('marks read/write correctly', async () => {
    const { gateway } = setup();
    const defs = new Map(gateway.list().map((d) => [d.name, d.readOnly]));
    expect(defs.get('doc.read')).toBe(true);
    expect(defs.get('doc.list')).toBe(true);
    expect(defs.get('doc.write')).toBe(false);
    expect(defs.get('doc.append')).toBe(false);
  });

  it('read of a missing file errors cleanly', async () => {
    const { gateway } = setup();
    await expect(gateway.execute('doc.read', { path: 'nope.md' })).rejects.toThrow(/not found/);
  });

  it('tool-level traversal is blocked', async () => {
    const { gateway } = setup();
    await expect(gateway.execute('doc.write', { path: '../evil.md', content: 'x' })).rejects.toThrow(
      /escapes/,
    );
    await expect(gateway.execute('doc.read', { path: '/etc/hostname' })).rejects.toThrow(/escapes/);
  });

  it('listDocFiles supports prefix filtering', async () => {
    const { dir, gateway } = setup();
    await gateway.execute('doc.write', { path: 'a/one.md', content: '1' });
    await gateway.execute('doc.write', { path: 'b/two.md', content: '2' });
    expect(listDocFiles(dir, 'a/')).toEqual(['a/one.md']);
    expect(listDocFiles(dir)).toEqual(['a/one.md', 'b/two.md']);
  });
});
