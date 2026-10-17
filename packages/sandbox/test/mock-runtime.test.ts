import { describe, expect, it } from 'vitest';
import { MockRuntime } from '../src/mock.js';
import { capOutput, withTimeout } from '../src/runtime.js';

describe('MockRuntime lifecycle', () => {
  it('create -> start -> exec -> stop -> remove', async () => {
    const rt = new MockRuntime();
    await rt.ensureReady();
    expect(await rt.status('a1')).toBe('missing');
    const id = await rt.create('a1');
    expect(id).toBe('a1');
    expect(await rt.status('a1')).toBe('stopped');
    await rt.start('a1');
    expect(await rt.status('a1')).toBe('running');
    const res = await rt.exec('a1', ['echo', 'hi']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('echo hi');
    await rt.stop('a1');
    expect(await rt.status('a1')).toBe('stopped');
    await rt.remove('a1');
    expect(await rt.status('a1')).toBe('missing');
  });

  it('create is idempotent and exec on missing container throws', async () => {
    const rt = new MockRuntime();
    await rt.create('a1');
    await rt.create('a1');
    await expect(rt.exec('ghost', ['ls'])).rejects.toThrow(/not found/);
    await expect(rt.exec('a1', [])).rejects.toThrow(/must not be empty/);
  });

  it('canned handlers match in registration order', async () => {
    const rt = new MockRuntime();
    await rt.create('a1');
    rt.onExec(/^date/, () => ({ stdout: '2026-01-01', stderr: '', exitCode: 0 }));
    rt.onExec(/.*/, () => ({ stdout: 'fallback', stderr: '', exitCode: 0 }));
    expect((await rt.exec('a1', ['date'])).stdout).toBe('2026-01-01');
    expect((await rt.exec('a1', ['uname'])).stdout).toBe('fallback');
    expect(rt.calls).toHaveLength(2);
    expect(rt.calls[0]?.cmd).toEqual(['date']);
  });
});

describe('timeout and output caps', () => {
  it('withTimeout rejects a hanging promise', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, 'test-op')).rejects.toThrow(
      /test-op timed out after 20ms/,
    );
  });

  it('MockRuntime.exec enforces the timeout', async () => {
    const rt = new MockRuntime({ timeoutMs: 30 });
    await rt.create('a1');
    rt.onExec(/.*/, () => new Promise(() => {}));
    await expect(rt.exec('a1', ['sleep', 'forever'])).rejects.toThrow(/timed out after 30ms/);
  });

  it('capOutput truncates with a marker and passes short text through', () => {
    expect(capOutput('short', 100)).toBe('short');
    const big = 'x'.repeat(2000);
    const capped = capOutput(big, 100);
    expect(capped.length).toBeLessThanOrEqual(100 + 50);
    expect(capped).toMatch(/\[truncated\]$/);
    // multi-byte safety: never splits a code point
    expect(capOutput('héllo wörld', 5)).not.toContain('�');
  });

  it('MockRuntime.exec caps oversized handler output', async () => {
    const rt = new MockRuntime({ maxOutputBytes: 64 });
    await rt.create('a1');
    rt.onExec(/.*/, () => ({ stdout: 'y'.repeat(10_000), stderr: '', exitCode: 0 }));
    const res = await rt.exec('a1', ['big']);
    expect(res.stdout.length).toBeLessThanOrEqual(64 + 50);
    expect(res.stdout).toMatch(/\[truncated\]$/);
  });
});
