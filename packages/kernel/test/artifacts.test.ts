// Tests for artifact.save / artifact.list: path jail, size caps, roundtrip.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolGateway } from '../src/tools.js';
import {
  registerArtifactTools,
  resolveArtifactPath,
  listArtifactFiles,
  MAX_ARTIFACT_BYTES,
} from '../src/artifacts.js';

function setup(): { gateway: ToolGateway; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'omni-artifacts-'));
  const gateway = new ToolGateway();
  registerArtifactTools(gateway, dir);
  return { gateway, dir };
}

describe('resolveArtifactPath', () => {
  it('adds .html when missing and blocks traversal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-artifacts-'));
    expect(resolveArtifactPath(dir, 'report')).toBe(join(dir, 'report.html'));
    expect(resolveArtifactPath(dir, 'a/b.html')).toBe(join(dir, 'a', 'b.html'));
    expect(() => resolveArtifactPath(dir, '../escape')).toThrow(/escapes/);
    expect(() => resolveArtifactPath(dir, '')).toThrow(/non-empty/);
  });
});

describe('artifact tools', () => {
  it('saves and lists roundtrip', async () => {
    const { gateway, dir } = setup();
    const out = await gateway.execute('artifact.save', {
      name: 'report',
      html: '<h1>Q3</h1><svg></svg>',
    });
    expect(out).toContain('report.html');
    expect(listArtifactFiles(dir)).toEqual(['report.html']);
    expect(await gateway.execute('artifact.list', {})).toBe('report.html');
  });

  it('registers with correct read/write classes', async () => {
    const { gateway } = setup();
    const defs = gateway.list();
    const save = defs.find((d) => d.name === 'artifact.save')!;
    const list = defs.find((d) => d.name === 'artifact.list')!;
    expect(save.readOnly).toBe(false); // policy-gated write
    expect(list.readOnly).toBe(true);
  });

  it('rejects empty html and traversal names', async () => {
    const { gateway } = setup();
    await expect(gateway.execute('artifact.save', { name: 'x', html: '  ' })).rejects.toThrow(/non-empty/);
    await expect(gateway.execute('artifact.save', { name: '../../evil', html: '<p>x</p>' })).rejects.toThrow(
      /escapes/,
    );
  });

  it('enforces the per-artifact size cap', async () => {
    const { gateway } = setup();
    const big = 'x'.repeat(MAX_ARTIFACT_BYTES + 1);
    await expect(gateway.execute('artifact.save', { name: 'big', html: big })).rejects.toThrow(/over the .* cap/);
  });

  it('enforces the directory total cap', async () => {
    const { gateway } = setup();
    // Fill ~9.98MB with 20 just-under-cap chunks (each save must pass), then
    // one more chunk must fail the DIRECTORY cap (not the per-file cap).
    const chunk = 'y'.repeat(MAX_ARTIFACT_BYTES - 1024);
    for (let i = 0; i < 20; i++) {
      await gateway.execute('artifact.save', { name: `c${i}`, html: chunk });
    }
    const near = 'z'.repeat(MAX_ARTIFACT_BYTES - 2048);
    await expect(gateway.execute('artifact.save', { name: 'overflow', html: near })).rejects.toThrow(
      /directory cap/,
    );
  });

  it('overwriting an existing artifact does not double-count its bytes', async () => {
    const { gateway } = setup();
    const half = 'a'.repeat(MAX_ARTIFACT_BYTES - 1024);
    await gateway.execute('artifact.save', { name: 'doc', html: half });
    // Overwrite with a slightly larger body — must pass since old bytes are replaced.
    const bigger = 'b'.repeat(MAX_ARTIFACT_BYTES - 512);
    const out = await gateway.execute('artifact.save', { name: 'doc', html: bigger });
    expect(out).toContain('doc.html');
  });

  it('lists only .html files', async () => {
    const { gateway, dir } = setup();
    await gateway.execute('artifact.save', { name: 'ok', html: '<p>hi</p>' });
    expect(listArtifactFiles(dir)).toEqual(['ok.html']);
  });
});
