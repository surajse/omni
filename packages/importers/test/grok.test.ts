import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateManifest } from '@omni/plugin-spec';
import { importGrokPlugin, sanitizePluginName } from '../src/grok.js';

const calcomDir = new URL('./fixtures/calcom', import.meta.url).pathname;
const stdioDir = new URL('./fixtures/local-stdio', import.meta.url).pathname;

describe('importGrokPlugin', () => {
  it('converts the real calcom layout: one mcp-http discover tool + skill file', () => {
    const { manifest, skillFiles } = importGrokPlugin(calcomDir);
    expect(manifest.manifestVersion).toBe('1.0');
    expect(manifest.name).toBe('calcom');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.author).toBe('Cal.com');
    expect(manifest.permissions).toContain('network');
    expect(manifest.tools).toHaveLength(1);
    const tool = manifest.tools[0]!;
    expect(tool.discover).toBe(true);
    expect(tool.readOnly).toBe(false);
    expect(tool.source).toEqual({ kind: 'mcp-http', url: 'https://mcp.cal.com/mcp' });
    expect(skillFiles).toHaveLength(1);
    expect(skillFiles[0]!.name).toBe('calcom');
    expect(skillFiles[0]!.markdown).toContain('Cal.com skill');
    // The converted manifest passes the official validator.
    expect(validateManifest(JSON.parse(JSON.stringify(manifest))).ok).toBe(true);
  });

  it('converts a stdio server with command, args, and env', () => {
    const { manifest, skillFiles } = importGrokPlugin(stdioDir);
    expect(manifest.name).toBe('local-stdio');
    expect(manifest.author).toBe('omni-tests');
    const tool = manifest.tools[0]!;
    expect(tool.source).toEqual({
      kind: 'mcp-stdio',
      command: 'node',
      args: ['server.js'],
      env: { DOCS_KEY: 'abc' },
    });
    expect(skillFiles).toHaveLength(0);
  });

  it('throws clear errors for missing or malformed inputs', () => {
    const empty = mkdtempSync(join(tmpdir(), 'omni-grok-'));
    expect(() => importGrokPlugin(empty)).toThrow(/missing .grok-plugin\/plugin.json/);

    const noMcp = mkdtempSync(join(tmpdir(), 'omni-grok-'));
    mkdirSync(join(noMcp, '.grok-plugin'), { recursive: true });
    writeFileSync(join(noMcp, '.grok-plugin', 'plugin.json'), '{"name":"x","version":"1.0.0"}');
    expect(() => importGrokPlugin(noMcp)).toThrow(/missing .mcp.json/);

    const badVer = mkdtempSync(join(tmpdir(), 'omni-grok-'));
    mkdirSync(join(badVer, '.grok-plugin'), { recursive: true });
    writeFileSync(join(badVer, '.grok-plugin', 'plugin.json'), '{"name":"x","version":"soon"}');
    writeFileSync(join(badVer, '.mcp.json'), '{"mcpServers":{"s":{"type":"http","url":"https://x"}}}');
    expect(() => importGrokPlugin(badVer)).toThrow(/semver/);
  });

  it('sanitizes odd plugin names', () => {
    expect(sanitizePluginName('Cal.com MCP!')).toBe('cal-com-mcp');
    expect(() => sanitizePluginName('!!!')).toThrow(/cannot sanitize/);
  });
});
