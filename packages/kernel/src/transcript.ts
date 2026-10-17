// Run transcripts: collect RunEvents during a run and persist them as JSONL.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunEvent } from './types.js';

export interface TranscriptEntry {
  seq: number;
  at: string;
  event: RunEvent;
}

/**
 * Collects run events in memory; can be handed to Agent as `onEvent` and
 * later saved to `<agentHome>/runs/<runId>.jsonl` for audit and skill learning.
 */
export class RunRecorder {
  private entries: TranscriptEntry[] = [];

  /** Suitable as the Agent `onEvent` callback. */
  readonly onEvent = (event: RunEvent): void => {
    this.record(event);
  };

  record(event: RunEvent): void {
    this.entries.push({ seq: this.entries.length, at: new Date().toISOString(), event });
  }

  list(): TranscriptEntry[] {
    return [...this.entries];
  }

  /** The tool-call sequence in order — the input to skill learning. */
  toolCalls(): Array<{ name: string; args: Record<string, unknown> }> {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    for (const entry of this.entries) {
      if (entry.event.type === 'tool-call') {
        calls.push({ name: entry.event.call.name, args: entry.event.call.arguments });
      }
    }
    return calls;
  }

  toJSONL(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n') + (this.entries.length > 0 ? '\n' : '');
  }

  /** Persist under `<dir>/runs/<runId>.jsonl`; returns the file path. */
  save(dir: string, runId: string): string {
    const runsDir = join(dir, 'runs');
    mkdirSync(runsDir, { recursive: true });
    const safeId = runId.replace(/[^a-zA-Z0-9-_]/g, '_');
    const path = join(runsDir, `${safeId}.jsonl`);
    writeFileSync(path, this.toJSONL());
    return path;
  }

  static loadFile(path: string): TranscriptEntry[] {
    const text = readFileSync(path, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TranscriptEntry);
  }

  /** Newest run file in `<dir>/runs`, or null when there are none. */
  static latestFile(dir: string): string | null {
    const runsDir = join(dir, 'runs');
    let files: string[];
    try {
      files = readdirSync(runsDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return null;
    }
    if (files.length === 0) return null;
    files.sort();
    return join(runsDir, files[files.length - 1]!);
  }
}
