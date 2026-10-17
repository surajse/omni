// Change detection primitives: hash snapshots, compare, excerpt.
// Pure functions — trivially testable, no I/O.
import { createHash } from 'node:crypto';

/** SHA-256 hex digest of the normalized content. */
export function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** First n characters of content, for notifications and snapshots. */
export function excerpt(s: string, n = 500): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** True when the content hash differs from the previous snapshot hash.
 * No baseline yet → false (the first fetch establishes the baseline). */
export function isChanged(prevHash: string | undefined, nextHash: string): boolean {
  if (!prevHash) return false;
  return prevHash !== nextHash;
}
