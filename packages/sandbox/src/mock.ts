// MockRuntime: in-memory ContainerRuntime for tests and for machines without
// Docker. Applies the same timeout and output-cap semantics as DockerRuntime.
import type { ContainerRuntime, ExecOptions, ExecResult } from './runtime.js';
import { capOutput, withTimeout } from './runtime.js';

export type ExecHandler = (cmd: string[]) => ExecResult | Promise<ExecResult>;

export interface MockRuntimeOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

function defaultHandler(cmd: string[]): ExecResult {
  return { stdout: `$ ${cmd.join(' ')}\n(mock output)`, stderr: '', exitCode: 0 };
}

export class MockRuntime implements ContainerRuntime {
  private readonly states = new Map<string, 'running' | 'stopped'>();
  private readonly handlers: Array<{ pattern: RegExp; handler: ExecHandler }> = [];
  /** Every exec call, in order — useful for assertions in tests. */
  readonly calls: Array<{ id: string; cmd: string[] }> = [];
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(opts: MockRuntimeOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  /** Register a canned response for commands matching `pattern` (tested against `cmd.join(' ')`). */
  onExec(pattern: RegExp, handler: ExecHandler): void {
    this.handlers.push({ pattern, handler });
  }

  async ensureReady(): Promise<void> {
    // The mock is always ready.
  }

  async create(agentId: string): Promise<string> {
    if (!this.states.has(agentId)) this.states.set(agentId, 'stopped');
    return agentId;
  }

  async start(id: string): Promise<void> {
    this.assertExists(id);
    this.states.set(id, 'running');
  }

  async stop(id: string): Promise<void> {
    this.assertExists(id);
    this.states.set(id, 'stopped');
  }

  async remove(id: string): Promise<void> {
    this.assertExists(id);
    this.states.delete(id);
  }

  async exec(id: string, cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    if (cmd.length === 0) throw new Error('MockRuntime.exec: cmd must not be empty');
    this.assertExists(id);
    this.calls.push({ id, cmd: [...cmd] });
    const joined = cmd.join(' ');
    const match = this.handlers.find((h) => h.pattern.test(joined));
    const handler = match ? match.handler : defaultHandler;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const maxBytes = opts.maxOutputBytes ?? this.maxOutputBytes;
    const raw = await withTimeout(Promise.resolve(handler(cmd)), timeoutMs, 'computer.exec');
    return {
      stdout: capOutput(raw.stdout, maxBytes),
      stderr: capOutput(raw.stderr, maxBytes),
      exitCode: raw.exitCode,
    };
  }

  async status(id: string): Promise<'running' | 'stopped' | 'missing'> {
    return this.states.get(id) ?? 'missing';
  }

  private assertExists(id: string): void {
    if (!this.states.has(id)) throw new Error(`container "${id}" not found — create it first`);
  }
}
