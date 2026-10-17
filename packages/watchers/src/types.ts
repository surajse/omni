// Watcher types: a watch observes a target (URL, file, command) on a cron
// schedule and fires the agent's task when the content meaningfully changes.
export type WatchTargetKind = 'url' | 'file' | 'command';

export interface WatchTarget {
  kind: WatchTargetKind;
  ref: string;
}

export interface Watch {
  id: string;
  agentId: string;
  target: WatchTarget;
  /** 5-field cron expression. */
  every: string;
  /** Task handed to the agent when a change is detected. */
  task: string;
  /** Minimum minutes between notifications for the same watch. */
  cooldownMinutes: number;
  createdAt: string;
}

export interface NewWatch {
  agentId: string;
  target: WatchTarget;
  every: string;
  task: string;
  cooldownMinutes?: number;
}

/**
 * Parse a target spec: `url:<...>`, `file:<path>`, `cmd:<shell>`.
 * Throws on unknown prefixes or empty refs.
 */
export function parseWatchTarget(spec: string): WatchTarget {
  const m = /^(url|file|cmd):([\s\S]+)$/.exec(spec.trim());
  if (!m || !m[2] || !m[2].trim()) {
    throw new Error(
      `invalid watch target "${spec}" — use url:<...>, file:<path>, or cmd:<shell command>`,
    );
  }
  const rawKind = m[1] as string;
  const kind: WatchTargetKind = rawKind === 'cmd' ? 'command' : (rawKind as WatchTargetKind);
  return { kind, ref: m[2].trim() };
}

/** Human-readable target, e.g. "url:https://example.com". */
export function formatWatchTarget(target: WatchTarget): string {
  const prefix = target.kind === 'command' ? 'cmd' : target.kind;
  return `${prefix}:${target.ref}`;
}
