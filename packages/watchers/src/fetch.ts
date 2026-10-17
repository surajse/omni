// Target fetching: pull the current text of a watched target.
// Caps keep one misbehaving target from blowing up memory; timeouts keep a
// hung fetch from stalling the daemon.
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import type { WatchTarget } from './types.js';

const FETCH_TIMEOUT_MS = 30_000;
const TEXT_CAP = 256 * 1024;
const CMD_CAP = 64 * 1024;

/** Collapse whitespace so trivial formatting churn doesn't count as change. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, TEXT_CAP);
}

async function fetchUrl(ref: string): Promise<string> {
  const res = await fetch(ref, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`url fetch failed: ${res.status} ${res.statusText}`);
  }
  return normalizeText(await res.text());
}

async function fetchFile(ref: string): Promise<string> {
  const raw = await readFile(ref, 'utf8');
  return normalizeText(raw);
}

function fetchCommand(ref: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'sh',
      ['-c', ref],
      { timeout: FETCH_TIMEOUT_MS, maxBuffer: CMD_CAP },
      (err, stdout, stderr) => {
        if (err) {
          const reason =
            (err as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timed out' : err.message;
          reject(new Error(`command failed (${reason}): ${stderr.trim().slice(0, 200)}`));
          return;
        }
        resolve(normalizeText(stdout));
      },
    );
  });
}

/** Fetch the current normalized text of a watch target. Throws on failure. */
export async function fetchTarget(target: WatchTarget): Promise<string> {
  switch (target.kind) {
    case 'url':
      return fetchUrl(target.ref);
    case 'file':
      return fetchFile(target.ref);
    case 'command':
      return fetchCommand(target.ref);
  }
}
