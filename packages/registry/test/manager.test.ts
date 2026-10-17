import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RegistryManager } from '../src/manager.js';

const examplesDir = new URL('../../../registries/examples', import.meta.url).pathname;
const calcomFixture = new URL('../../importers/test/fixtures/calcom', import.meta.url).pathname;

function writeSourceDir(root: string, plugins: Array<{ name: string; dir: string }>): string {
  const dir = join(root, 'source');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({
      version: 1,
      plugins: plugins.map((p) => ({
        name: p.name,
        version: '1.0.0',
        description: `Test plugin ${p.name}`,
        keywords: ['test'],
        source: { type: 'path', path: p.dir },
      })),
    }),
  );
  return dir;
}

describe('RegistryManager', () => {
  it('adds a local source, searches, installs, lists, and removes', () => {
    const home = mkdtempSync(join(tmpdir(), 'omni-reg-'));
    const mgr = new RegistryManager(home);

    const rec = mgr.addSource('examples', examplesDir);
    expect(rec.kind).toBe('path');
    expect(mgr.listSources()).toHaveLength(1);
    expect(() => mgr.addSource('examples', examplesDir)).toThrow(/already exists/);
    expect(() => mgr.addSource('Bad Name', examplesDir)).toThrow(/invalid source name/);

    const hits = mgr.search('echo');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.name).toBe('echo');
    expect(mgr.search('EXAMPLE')).toHaveLength(2); // case-insensitive, matches both
    expect(mgr.search('nothing-here')).toHaveLength(0);

    const res = mgr.install('echo');
    expect(res.convertedFromGrok).toBe(false);
    expect(res.name).toBe('echo');
    expect(existsSync(join(res.installedPath, 'omni.plugin.json'))).toBe(true);
    expect(mgr.listInstalled()).toEqual(['echo']);
    expect(() => mgr.install('echo')).toThrow(/already installed/);
    expect(() => mgr.install('nope')).toThrow(/not found in any registry source/);

    mgr.removeInstalled('echo');
    expect(mgr.listInstalled()).toEqual([]);
    expect(() => mgr.removeInstalled('echo')).toThrow(/not installed/);

    mgr.removeSource('examples');
    expect(mgr.listSources()).toHaveLength(0);
    expect(() => mgr.removeSource('examples')).toThrow(/unknown registry source/);
  });

  it('auto-converts a .grok-plugin on install', () => {
    const home = mkdtempSync(join(tmpdir(), 'omni-reg-'));
    const root = mkdtempSync(join(tmpdir(), 'omni-regsrc-'));
    const dir = writeSourceDir(root, [{ name: 'calcom', dir: calcomFixture }]);
    const mgr = new RegistryManager(home);
    mgr.addSource('grokstuff', dir);

    const res = mgr.install('calcom');
    expect(res.convertedFromGrok).toBe(true);
    const manifest = JSON.parse(readFileSync(join(res.installedPath, 'omni.plugin.json'), 'utf8'));
    expect(manifest.name).toBe('calcom');
    expect(manifest.tools[0].source.kind).toBe('mcp-http');
    expect(existsSync(join(res.installedPath, 'skills', 'calcom', 'SKILL.md'))).toBe(true);
  });

  it('rejects invalid manifests and non-plugin directories', () => {
    const home = mkdtempSync(join(tmpdir(), 'omni-reg-'));
    const root = mkdtempSync(join(tmpdir(), 'omni-regsrc-'));
    const badDir = join(root, 'bad');
    const emptyDir = join(root, 'empty');
    mkdirSync(badDir, { recursive: true });
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(badDir, 'omni.plugin.json'), '{"manifestVersion":"1.0","name":"x"}');
    const dir = writeSourceDir(root, [
      { name: 'bad', dir: badDir },
      { name: 'empty', dir: emptyDir },
    ]);
    const mgr = new RegistryManager(home);
    mgr.addSource('t', dir);
    expect(() => mgr.install('bad')).toThrow(/invalid omni.plugin.json/);
    expect(mgr.listInstalled()).toEqual([]);
    expect(() => mgr.install('empty')).toThrow(/neither an Omni plugin/);
  });
});
