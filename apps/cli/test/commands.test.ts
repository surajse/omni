import { describe, expect, it } from 'vitest';
import { parseIdList, parsePort, parseRoutineAdd, parseTickMs } from '../src/index.js';

describe('parseRoutineAdd', () => {
  it('parses agent, cron, and multi-word task', () => {
    expect(parseRoutineAdd(['scout', '*/5 * * * *', 'check', 'the', 'inbox'])).toEqual({
      agentId: 'scout',
      cron: '*/5 * * * *',
      task: 'check the inbox',
    });
  });

  it('throws on missing args', () => {
    expect(() => parseRoutineAdd([])).toThrow(/usage/);
    expect(() => parseRoutineAdd(['scout'])).toThrow(/usage/);
    expect(() => parseRoutineAdd(['scout', '* * * * *'])).toThrow(/usage/);
  });

  it('throws on invalid cron', () => {
    expect(() => parseRoutineAdd(['scout', 'not-a-cron', 'task'])).toThrow(/invalid cron/);
    expect(() => parseRoutineAdd(['scout', '61 * * * *', 'task'])).toThrow(/out of range/);
  });
});

describe('parsePort', () => {
  it('returns undefined when --port is absent', () => {
    expect(parsePort([])).toBeUndefined();
    expect(parsePort(['scout'])).toBeUndefined();
  });

  it('parses --port N', () => {
    expect(parsePort(['--port', '8080'])).toBe(8080);
  });

  it('rejects bad ports', () => {
    expect(() => parsePort(['--port', '0'])).toThrow(/1-65535/);
    expect(() => parsePort(['--port', '99999'])).toThrow(/1-65535/);
    expect(() => parsePort(['--port', 'abc'])).toThrow(/1-65535/);
    expect(() => parsePort(['--port'])).toThrow(/1-65535/);
  });
});

describe('parseTickMs', () => {
  it('defaults to 30s', () => {
    expect(parseTickMs([])).toBe(30_000);
  });

  it('parses --tick-ms', () => {
    expect(parseTickMs(['--tick-ms', '5000'])).toBe(5000);
  });

  it('rejects too-small values', () => {
    expect(() => parseTickMs(['--tick-ms', '500'])).toThrow(/>= 1000/);
    expect(() => parseTickMs(['--tick-ms', 'x'])).toThrow(/>= 1000/);
  });
});

describe('parseIdList', () => {
  it('parses comma-separated ids', () => {
    expect(parseIdList('1,2, 3')).toEqual([1, 2, 3]);
  });

  it('returns undefined for unset or junk', () => {
    expect(parseIdList(undefined)).toBeUndefined();
    expect(parseIdList('')).toBeUndefined();
    expect(parseIdList('abc')).toBeUndefined();
  });
});
