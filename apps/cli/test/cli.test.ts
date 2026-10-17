import { describe, expect, it } from 'vitest';
import { defaultConfig, slugify } from '../src/index.js';

describe('slugify', () => {
  it('lowercases, dasherizes, and strips invalid characters', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
    expect(slugify('  My_Agent 007 ')).toBe('my-agent-007');
    expect(slugify('!!!')).toBe('agent');
  });
});

describe('defaultConfig', () => {
  it('builds a valid agent config from a display name', () => {
    const config = defaultConfig('Friday Assistant');
    expect(config.id).toBe('friday-assistant');
    expect(config.id).toMatch(/^[a-z0-9-]+$/);
    expect(config.memoryNamespace).toBe(config.id);
    expect(config.tools).toContain('get_time');
    expect(config.systemPrompt).toContain('Friday Assistant');
  });
});
