// Computer-use tools: register an agent's computer (a ContainerRuntime
// container) as tools on a ToolGateway. computer.exec and computer.write_file
// are write-class (policy default: ask); computer.read_file is read-only.
import type { ToolGateway } from '@omni/kernel';
import type { ContainerRuntime } from './runtime.js';

function strArg(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`computer tool: argument "${name}" must be a non-empty string`);
  }
  return v;
}

/** Single-quote a string for safe embedding in a sh -c script. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function formatExecResult(r: { stdout: string; stderr: string; exitCode: number }): string {
  const out = r.stdout.replace(/\s+$/, '');
  const err = r.stderr.replace(/\s+$/, '');
  let text = `exit code: ${r.exitCode}`;
  text += `\n--- stdout ---\n${out || '(empty)'}`;
  if (err) text += `\n--- stderr ---\n${err}`;
  return text;
}

/**
 * Register computer.exec / computer.read_file / computer.write_file on
 * `gateway`, bound to `containerId` on `runtime`.
 */
export function registerComputerTools(
  gateway: ToolGateway,
  runtime: ContainerRuntime,
  containerId: string,
): void {
  gateway.register(
    {
      name: 'computer.exec',
      description:
        'Run a shell command inside the agent\u2019s computer and return its output. ' +
        'Prefer read-only commands; anything destructive needs approval per policy.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run (sh -c).' },
        },
        required: ['command'],
      },
      readOnly: false,
    },
    async (args) => {
      const command = strArg(args, 'command');
      const res = await runtime.exec(containerId, ['sh', '-c', command]);
      return formatExecResult(res);
    },
  );

  gateway.register(
    {
      name: 'computer.read_file',
      description: 'Read a text file from the agent\u2019s computer.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path inside the container.' },
        },
        required: ['path'],
      },
      readOnly: true,
    },
    async (args) => {
      const path = strArg(args, 'path');
      const res = await runtime.exec(containerId, ['cat', '--', path]);
      if (res.exitCode !== 0) {
        throw new Error(`computer.read_file failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
      }
      return res.stdout;
    },
  );

  gateway.register(
    {
      name: 'computer.write_file',
      description: 'Write (overwrite) a text file on the agent\u2019s computer.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path inside the container.' },
          content: { type: 'string', description: 'Full file content.' },
        },
        required: ['path', 'content'],
      },
      readOnly: false,
    },
    async (args) => {
      const path = strArg(args, 'path');
      const content = strArg(args, 'content');
      // base64 round-trip avoids every quoting problem except the path's.
      const b64 = Buffer.from(content, 'utf8').toString('base64');
      const script = `printf '%s' ${shQuote(b64)} | base64 -d > ${shQuote(path)}`;
      const res = await runtime.exec(containerId, ['sh', '-c', script]);
      if (res.exitCode !== 0) {
        throw new Error(`computer.write_file failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
      }
      return `wrote ${content.length} characters to ${path}`;
    },
  );
}
