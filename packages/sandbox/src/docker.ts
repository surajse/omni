// DockerRuntime: ContainerRuntime implemented by shelling out to the `docker`
// CLI (no Docker SDK dependency). Each agent gets one container
// (`omni-<agentId>`) and one persistent volume (`omni-<agentId>-data`
// mounted at /home/agent). Containers run `<image> sleep infinity`.
import { execFile } from 'node:child_process';
import type { ContainerRuntime, ExecOptions, ExecResult } from './runtime.js';
import { capOutput } from './runtime.js';

export interface DockerRuntimeOptions {
  /** Container image. Defaults to OMNI_SANDBOX_IMAGE, then ubuntu:24.04. */
  image?: string;
  /** Default per-exec timeout. Defaults to 60s. */
  timeoutMs?: number;
  /** Default per-stream output cap. Defaults to 64KB. */
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DOCKER_NOT_FOUND =
  'Docker not found: install Docker (https://docs.docker.com/get-docker/) and make sure the `docker` CLI is on PATH.';

function sanitizeAgentId(agentId: string): string {
  const clean = agentId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!clean) throw new Error('DockerRuntime: agentId must contain at least one of [a-z0-9-]');
  return clean;
}

interface DockerCallResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class DockerRuntime implements ContainerRuntime {
  private readonly image: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(opts: DockerRuntimeOptions = {}) {
    this.image = opts.image ?? process.env['OMNI_SANDBOX_IMAGE'] ?? 'ubuntu:24.04';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  containerName(agentId: string): string {
    return `omni-${sanitizeAgentId(agentId)}`;
  }

  volumeName(agentId: string): string {
    return `${this.containerName(agentId)}-data`;
  }

  /** Low-level `docker` invocation. Non-zero exits resolve (with exitCode); only
   *  infrastructure failures (missing CLI, timeout) reject. */
  private docker(args: string[], timeoutMs?: number): Promise<DockerCallResult> {
    const timeout = timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      execFile(
        'docker',
        args,
        { timeout, maxBuffer: 32 * 1024 * 1024 },
        (err: unknown, stdout: string, stderr: string) => {
          if (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean };
            if (e.code === 'ENOENT') {
              reject(new Error(DOCKER_NOT_FOUND));
              return;
            }
            if (e.killed) {
              reject(new Error(`docker ${args[0] ?? ''} timed out after ${timeout}ms`));
              return;
            }
            resolve({
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? ''),
              exitCode: typeof e.code === 'number' ? e.code : 1,
            });
            return;
          }
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: 0 });
        },
      );
    });
  }

  async ensureReady(): Promise<void> {
    let res: DockerCallResult;
    try {
      res = await this.docker(['info'], 15_000);
    } catch (err) {
      // docker() already translates ENOENT; rethrow with context otherwise.
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (res.exitCode !== 0) {
      throw new Error(
        `Docker daemon not available: ${res.stderr.trim() || `docker info exited ${res.exitCode}`}`,
      );
    }
  }

  async create(agentId: string): Promise<string> {
    const name = this.containerName(agentId);
    const volume = this.volumeName(agentId);
    if ((await this.status(name)) !== 'missing') return name;
    const vol = await this.docker(['volume', 'create', volume]);
    if (vol.exitCode !== 0) {
      throw new Error(`docker volume create failed: ${vol.stderr.trim()}`);
    }
    const created = await this.docker([
      'create',
      '--name',
      name,
      '-v',
      `${volume}:/home/agent`,
      this.image,
      'sleep',
      'infinity',
    ]);
    if (created.exitCode !== 0) {
      throw new Error(`docker create failed: ${created.stderr.trim()}`);
    }
    return name;
  }

  async start(id: string): Promise<void> {
    const res = await this.docker(['start', id]);
    if (res.exitCode !== 0) throw new Error(`docker start failed: ${res.stderr.trim()}`);
  }

  async stop(id: string): Promise<void> {
    const res = await this.docker(['stop', '-t', '10', id]);
    if (res.exitCode !== 0) throw new Error(`docker stop failed: ${res.stderr.trim()}`);
  }

  async remove(id: string): Promise<void> {
    // The data volume is intentionally left behind: it is the agent's disk.
    const res = await this.docker(['rm', '-f', id]);
    if (res.exitCode !== 0) throw new Error(`docker rm failed: ${res.stderr.trim()}`);
  }

  async exec(id: string, cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    if (cmd.length === 0) throw new Error('DockerRuntime.exec: cmd must not be empty');
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const maxBytes = opts.maxOutputBytes ?? this.maxOutputBytes;
    const res = await this.docker(['exec', id, ...cmd], timeoutMs);
    if (res.exitCode !== 0 && /no such container/i.test(res.stderr)) {
      throw new Error(`container "${id}" not found — create it first`);
    }
    return {
      stdout: capOutput(res.stdout, maxBytes),
      stderr: capOutput(res.stderr, maxBytes),
      exitCode: res.exitCode,
    };
  }

  async status(id: string): Promise<'running' | 'stopped' | 'missing'> {
    const res = await this.docker(['inspect', '-f', '{{.State.Running}}', id]);
    if (res.exitCode !== 0) {
      if (/no such object/i.test(res.stderr)) return 'missing';
      throw new Error(`docker inspect failed: ${res.stderr.trim()}`);
    }
    return res.stdout.trim() === 'true' ? 'running' : 'stopped';
  }
}
