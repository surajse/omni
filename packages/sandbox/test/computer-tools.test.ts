import { describe, expect, it } from 'vitest';
import { ToolGateway } from '@omni/kernel';
import { MockRuntime } from '../src/mock.js';
import { registerComputerTools } from '../src/computer-tools.js';

function setup() {
  const gateway = new ToolGateway();
  const runtime = new MockRuntime();
  return { gateway, runtime };
}

describe('registerComputerTools', () => {
  it('registers three tools with correct read/write marks', async () => {
    const { gateway, runtime } = setup();
    await runtime.create('a1');
    registerComputerTools(gateway, runtime, 'a1');
    const defs = new Map(gateway.list().map((d) => [d.name, d]));
    expect(defs.get('computer.exec')?.readOnly).toBe(false);
    expect(defs.get('computer.write_file')?.readOnly).toBe(false);
    expect(defs.get('computer.read_file')?.readOnly).toBe(true);
    for (const name of ['computer.exec', 'computer.read_file', 'computer.write_file']) {
      expect(defs.get(name)?.parameters).toHaveProperty('required');
    }
  });

  it('computer.exec delegates to runtime.exec via sh -c', async () => {
    const { gateway, runtime } = setup();
    await runtime.create('a1');
    runtime.onExec(/^sh -c/, (cmd) => ({ stdout: `ran: ${cmd[2]}`, stderr: '', exitCode: 0 }));
    registerComputerTools(gateway, runtime, 'a1');
    const out = await gateway.execute('computer.exec', { command: 'ls /home/agent' });
    expect(out).toContain('exit code: 0');
    expect(out).toContain('ran: ls /home/agent');
    expect(runtime.calls[0]).toEqual({ id: 'a1', cmd: ['sh', '-c', 'ls /home/agent'] });
  });

  it('computer.write_file round-trips content through base64', async () => {
    const { gateway, runtime } = setup();
    await runtime.create('a1');
    let captured = '';
    runtime.onExec(/^sh -c/, (cmd) => {
      captured = cmd[2] ?? '';
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    registerComputerTools(gateway, runtime, 'a1');
    const content = "it's a \"test\" with 'quotes'\nand newline";
    const out = await gateway.execute('computer.write_file', { path: '/home/agent/n.txt', content });
    expect(out).toContain('wrote');
    // The base64 payload must decode back to the exact content.
    const m = captured.match(/printf '%s' '([A-Za-z0-9+/=]+)'/);
    expect(m).not.toBeNull();
    expect(Buffer.from(m?.[1] ?? '', 'base64').toString('utf8')).toBe(content);
    expect(captured).toContain(`> '/home/agent/n.txt'`);
  });

  it('computer.read_file returns stdout and throws on missing file', async () => {
    const { gateway, runtime } = setup();
    await runtime.create('a1');
    runtime.onExec(/^cat/, (cmd) => {
      const path = cmd[cmd.length - 1] ?? '';
      if (path === '/home/agent/ok.txt') return { stdout: 'file-contents', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: 'cat: /home/agent/no.txt: No such file', exitCode: 1 };
    });
    registerComputerTools(gateway, runtime, 'a1');
    expect(await gateway.execute('computer.read_file', { path: '/home/agent/ok.txt' })).toBe(
      'file-contents',
    );
    await expect(gateway.execute('computer.read_file', { path: '/home/agent/no.txt' })).rejects.toThrow(
      /No such file/,
    );
  });

  it('rejects empty arguments', async () => {
    const { gateway, runtime } = setup();
    await runtime.create('a1');
    registerComputerTools(gateway, runtime, 'a1');
    await expect(gateway.execute('computer.exec', { command: '' })).rejects.toThrow(/non-empty string/);
    await expect(gateway.execute('computer.read_file', {})).rejects.toThrow(/"path"/);
  });
});
