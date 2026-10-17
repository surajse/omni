import { describe, expect, it } from 'vitest';
import { parseWatchAdd } from '../src/index.js';

describe('parseWatchAdd', () => {
  it('parses a full watch add', () => {
    expect(
      parseWatchAdd(['scout', 'url:https://example.com', '--every', '*/15 * * * *', '--task', 'check price', '--cooldown', '30']),
    ).toEqual({
      agentId: 'scout',
      target: 'url:https://example.com',
      every: '*/15 * * * *',
      task: 'check price',
      cooldownMinutes: 30,
    });
  });

  it('defaults cooldown to 60', () => {
    const p = parseWatchAdd(['scout', 'file:/tmp/x', '--every', '* * * * *', '--task', 't']);
    expect(p.cooldownMinutes).toBe(60);
  });

  it('throws on missing agent/target', () => {
    expect(() => parseWatchAdd([])).toThrow(/usage/);
    expect(() => parseWatchAdd(['scout'])).toThrow(/usage/);
  });

  it('throws when --every or --task is missing', () => {
    expect(() => parseWatchAdd(['scout', 'url:https://x', '--task', 't'])).toThrow(/--every/);
    expect(() => parseWatchAdd(['scout', 'url:https://x', '--every', '* * * * *'])).toThrow(/--task/);
  });

  it('throws on invalid cron', () => {
    expect(() =>
      parseWatchAdd(['scout', 'url:https://x', '--every', 'nope', '--task', 't']),
    ).toThrow(/invalid cron/i);
  });

  it('throws on bad target spec', () => {
    expect(() =>
      parseWatchAdd(['scout', 'https://x', '--every', '* * * * *', '--task', 't']),
    ).toThrow(/invalid watch target/);
  });

  it('throws on bad cooldown', () => {
    expect(() =>
      parseWatchAdd(['scout', 'url:https://x', '--every', '* * * * *', '--task', 't', '--cooldown', '-5']),
    ).toThrow(/--cooldown/);
    expect(() =>
      parseWatchAdd(['scout', 'url:https://x', '--every', '* * * * *', '--task', 't', '--cooldown', 'abc']),
    ).toThrow(/--cooldown/);
  });
});
