import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateManifest } from '../src/schema.js';

const examplePath = new URL('../plugins/examples/hello.omni-plugin.json', import.meta.url);

describe('validateManifest', () => {
  it('accepts the bundled hello example manifest', () => {
    const json: unknown = JSON.parse(readFileSync(examplePath, 'utf8'));
    const result = validateManifest(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe('hello');
      expect(result.manifest.tools).toHaveLength(2);
    }
  });

  it('rejects a missing name', () => {
    const result = validateManifest({ manifestVersion: '1.0', version: '1.0.0', tools: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('name'))).toBe(true);
    }
  });

  it('rejects a bad version', () => {
    const result = validateManifest({
      manifestVersion: '1.0',
      name: 'demo',
      version: 'not-a-version',
      tools: [
        {
          name: 't',
          description: 'd',
          parameters: {},
          source: { kind: 'builtin', ref: 'x' },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('version'))).toBe(true);
    }
  });

  it('rejects a bad tool source kind', () => {
    const result = validateManifest({
      manifestVersion: '1.0',
      name: 'demo',
      version: '1.0.0',
      tools: [
        {
          name: 't',
          description: 'd',
          parameters: {},
          source: { kind: 'websocket', url: 'x' },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('unknown source kind'))).toBe(true);
    }
  });

  it('rejects an mcp-stdio source without a command and duplicate tool names', () => {
    const result = validateManifest({
      manifestVersion: '1.0',
      name: 'demo',
      version: '1.0.0',
      tools: [
        { name: 't', description: 'd', parameters: {}, source: { kind: 'mcp-stdio' } },
        { name: 't', description: 'd', parameters: {}, source: { kind: 'builtin', ref: 'x' } },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('command'))).toBe(true);
      expect(result.errors.some((e) => e.includes('duplicate tool name'))).toBe(true);
    }
  });

  it('rejects non-object input and wrong manifestVersion', () => {
    expect(validateManifest(null).ok).toBe(false);
    const result = validateManifest({
      manifestVersion: '2.0',
      name: 'demo',
      version: '1.0.0',
      tools: [{ name: 't', description: 'd', parameters: {}, source: { kind: 'builtin', ref: 'x' } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('manifestVersion'))).toBe(true);
    }
  });
});
