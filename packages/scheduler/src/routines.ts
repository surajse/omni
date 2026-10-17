// RoutineStore: per-agent routine definitions persisted as JSON.
// Each agent keeps its routines at <agentHome>/routines.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateCron } from './cron.js';

export interface Routine {
  id: string;
  agentId: string;
  cron: string;
  task: string;
  enabled: boolean;
  createdAt: string;
}

export interface NewRoutine {
  agentId: string;
  cron: string;
  task: string;
  enabled?: boolean;
}

function isRoutine(v: unknown): v is Routine {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['agentId'] === 'string' &&
    typeof r['cron'] === 'string' &&
    typeof r['task'] === 'string' &&
    typeof r['enabled'] === 'boolean' &&
    typeof r['createdAt'] === 'string'
  );
}

export class RoutineStore {
  constructor(private readonly agentHome: string) {}

  private filePath(): string {
    return join(this.agentHome, 'routines.json');
  }

  private readAll(): Routine[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath(), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`corrupt routines file: ${this.filePath()}`);
    }
    if (!Array.isArray(parsed) || !parsed.every(isRoutine)) {
      throw new Error(`corrupt routines file: ${this.filePath()}`);
    }
    return parsed;
  }

  private writeAll(routines: Routine[]): void {
    mkdirSync(this.agentHome, { recursive: true });
    writeFileSync(this.filePath(), JSON.stringify(routines, null, 2) + '\n', 'utf8');
  }

  add(nr: NewRoutine): Routine {
    if (!nr.task.trim()) throw new Error('routine task must not be empty');
    validateCron(nr.cron); // throws on invalid
    const routines = this.readAll();
    const routine: Routine = {
      id: `r_${randomBytes(8).toString('hex')}`,
      agentId: nr.agentId,
      cron: nr.cron.trim(),
      task: nr.task,
      enabled: nr.enabled ?? true,
      createdAt: new Date().toISOString(),
    };
    routines.push(routine);
    this.writeAll(routines);
    return routine;
  }

  list(): Routine[] {
    return this.readAll();
  }

  get(id: string): Routine {
    const found = this.readAll().find((r) => r.id === id);
    if (!found) throw new Error(`routine not found: ${id}`);
    return found;
  }

  remove(id: string): void {
    const routines = this.readAll();
    const kept = routines.filter((r) => r.id !== id);
    if (kept.length === routines.length) throw new Error(`routine not found: ${id}`);
    this.writeAll(kept);
  }

  toggle(id: string, enabled: boolean): Routine {
    const routines = this.readAll();
    const found = routines.find((r) => r.id === id);
    if (!found) throw new Error(`routine not found: ${id}`);
    found.enabled = enabled;
    this.writeAll(routines);
    return found;
  }
}
