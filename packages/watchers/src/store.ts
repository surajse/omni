// WatchStore: per-agent watches + content snapshots, persisted as JSON.
// Layout: <agentHome>/watches.json, <agentHome>/watch-snapshots.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateCron } from '@omni/scheduler';
import type { NewWatch, Watch } from './types.js';

export interface WatchSnapshot {
  hash: string;
  excerpt: string;
  fetchedAt: string;
  /** ISO timestamp of the last notification sent for this watch. */
  lastNotifiedAt?: string;
}

function isWatch(v: unknown): v is Watch {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const t = r['target'] as Record<string, unknown> | undefined;
  return (
    typeof r['id'] === 'string' &&
    typeof r['agentId'] === 'string' &&
    typeof t === 'object' &&
    t !== null &&
    ['url', 'file', 'command'].includes(t['kind'] as string) &&
    typeof t['ref'] === 'string' &&
    typeof r['every'] === 'string' &&
    typeof r['task'] === 'string' &&
    typeof r['cooldownMinutes'] === 'number' &&
    typeof r['createdAt'] === 'string'
  );
}

function readJsonFile<T>(path: string, validate: (v: unknown) => v is T, fallback: T): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`corrupt watch file: ${path}`);
  }
  if (!validate(parsed)) throw new Error(`corrupt watch file: ${path}`);
  return parsed;
}

const isWatchArray = (v: unknown): v is Watch[] => Array.isArray(v) && v.every(isWatch);
const isSnapshotMap = (v: unknown): v is Record<string, WatchSnapshot> =>
  typeof v === 'object' && v !== null;

export class WatchStore {
  constructor(private readonly agentHome: string) {}

  private watchesPath(): string {
    return join(this.agentHome, 'watches.json');
  }

  private snapshotsPath(): string {
    return join(this.agentHome, 'watch-snapshots.json');
  }

  private writeWatches(watches: Watch[]): void {
    mkdirSync(this.agentHome, { recursive: true });
    writeFileSync(this.watchesPath(), JSON.stringify(watches, null, 2) + '\n', 'utf8');
  }

  private writeSnapshots(snaps: Record<string, WatchSnapshot>): void {
    mkdirSync(this.agentHome, { recursive: true });
    writeFileSync(this.snapshotsPath(), JSON.stringify(snaps, null, 2) + '\n', 'utf8');
  }

  add(nw: NewWatch): Watch {
    if (!nw.task.trim()) throw new Error('watch task must not be empty');
    validateCron(nw.every); // throws on invalid
    const cooldownMinutes = nw.cooldownMinutes ?? 60;
    if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 0) {
      throw new Error('cooldownMinutes must be a non-negative number');
    }
    const watches = this.list();
    const watch: Watch = {
      id: `w_${randomBytes(8).toString('hex')}`,
      agentId: nw.agentId,
      target: nw.target,
      every: nw.every.trim(),
      task: nw.task,
      cooldownMinutes,
      createdAt: new Date().toISOString(),
    };
    watches.push(watch);
    this.writeWatches(watches);
    return watch;
  }

  list(): Watch[] {
    return readJsonFile(this.watchesPath(), isWatchArray, []);
  }

  get(id: string): Watch {
    const found = this.list().find((w) => w.id === id);
    if (!found) throw new Error(`watch not found: ${id}`);
    return found;
  }

  remove(id: string): void {
    const watches = this.list();
    const kept = watches.filter((w) => w.id !== id);
    if (kept.length === watches.length) throw new Error(`watch not found: ${id}`);
    this.writeWatches(kept);
    const snaps = this.snapshots();
    delete snaps[id];
    this.writeSnapshots(snaps);
  }

  snapshots(): Record<string, WatchSnapshot> {
    return readJsonFile(this.snapshotsPath(), isSnapshotMap, {});
  }

  getSnapshot(id: string): WatchSnapshot | undefined {
    return this.snapshots()[id];
  }

  setSnapshot(id: string, snap: WatchSnapshot): void {
    const snaps = this.snapshots();
    snaps[id] = snap;
    this.writeSnapshots(snaps);
  }
}
