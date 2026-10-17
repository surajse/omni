// Watch engine: check one watch — fetch, diff against the snapshot, and
// decide whether the agent should be notified (change + cooldown elapsed).
import { excerpt, isChanged, sha256hex } from './diff.js';
import { fetchTarget } from './fetch.js';
import type { WatchStore } from './store.js';
import type { Watch } from './types.js';

export interface CheckResult {
  changed: boolean;
  /** Current content excerpt (present when changed). */
  excerpt?: string;
  hash: string;
}

/**
 * Check a single watch. First-ever fetch only stores the baseline (no
 * false-positive "change"). A content change updates the snapshot; it is
 * reported only when the cooldown since the last notification has elapsed.
 */
export async function checkWatch(
  store: WatchStore,
  watch: Watch,
  fetchImpl: (target: Watch['target']) => Promise<string> = fetchTarget,
): Promise<CheckResult> {
  const content = await fetchImpl(watch.target);
  const hash = sha256hex(content);
  const now = new Date().toISOString();
  const prev = store.getSnapshot(watch.id);

  if (!prev) {
    store.setSnapshot(watch.id, { hash, excerpt: excerpt(content), fetchedAt: now });
    return { changed: false, hash };
  }

  const contentChanged = isChanged(prev.hash, hash);
  const snapshot = { hash, excerpt: excerpt(content), fetchedAt: now, lastNotifiedAt: prev.lastNotifiedAt };
  if (!contentChanged) {
    store.setSnapshot(watch.id, snapshot);
    return { changed: false, hash };
  }

  const cooldownMs = watch.cooldownMinutes * 60_000;
  const lastNotified = prev.lastNotifiedAt ? Date.parse(prev.lastNotifiedAt) : 0;
  const cooledDown = Date.now() - lastNotified >= cooldownMs;
  if (cooledDown) {
    snapshot.lastNotifiedAt = now;
  }
  store.setSnapshot(watch.id, snapshot);
  return cooledDown ? { changed: true, excerpt: excerpt(content), hash } : { changed: false, hash };
}
