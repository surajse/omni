// ContainerRuntime: the interface between Omni agents and "their computer".
// DockerRuntime (docker.ts) is the real implementation; MockRuntime (mock.ts)
// is an in-memory fake for tests and for machines without Docker.

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  /** Kill the command after this long. Runtimes apply their own default. */
  timeoutMs?: number;
  /** Truncate stdout/stderr beyond this many bytes. Runtimes apply their own default. */
  maxOutputBytes?: number;
}

export interface ContainerRuntime {
  /** Throw a clear error if the runtime backend is unavailable. */
  ensureReady(): Promise<void>;
  /** Create (but do not start) the agent's computer. Returns the container id. Idempotent. */
  create(agentId: string): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  /** Remove the container. Persistent volumes are left in place (see docs/SANDBOX.md). */
  remove(id: string): Promise<void>;
  exec(id: string, cmd: string[], opts?: ExecOptions): Promise<ExecResult>;
  status(id: string): Promise<'running' | 'stopped' | 'missing'>;
}

/** Reject if `promise` does not settle within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const TRUNCATED_MARKER = '\n…[truncated]';

/** Truncate text to maxBytes (UTF-8), appending a marker when truncated. */
export function capOutput(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString('utf8') + TRUNCATED_MARKER;
}
