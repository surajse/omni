// File-backed agent registry: one JSON document per agent id.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig } from './types.js';

const ID_RE = /^[a-z0-9-]+$/;

export class AgentRegistry {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  create(config: AgentConfig): AgentConfig {
    if (!ID_RE.test(config.id)) {
      throw new Error(`Invalid agent id "${config.id}": must match ${ID_RE.source}`);
    }
    if (existsSync(this.pathFor(config.id))) {
      throw new Error(`Agent already exists: ${config.id}`);
    }
    writeFileSync(this.pathFor(config.id), JSON.stringify(config, null, 2) + '\n');
    return config;
  }

  get(id: string): AgentConfig {
    const path = this.pathFor(id);
    if (!existsSync(path)) {
      throw new Error(`Unknown agent: ${id}`);
    }
    return JSON.parse(readFileSync(path, 'utf8')) as AgentConfig;
  }

  list(): AgentConfig[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as AgentConfig);
  }

  remove(id: string): void {
    const path = this.pathFor(id);
    if (!existsSync(path)) {
      throw new Error(`Unknown agent: ${id}`);
    }
    rmSync(path);
  }
}
