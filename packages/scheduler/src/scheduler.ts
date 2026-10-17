// Scheduler: ticks on an interval and dispatches routines whose cron matches
// the current minute. Each routine fires at most once per minute (tracked by
// routine id), and dispatch errors are logged, never thrown into the loop.
import { matchesCron } from './cron.js';
import type { Routine, RoutineStore } from './routines.js';

export interface SchedulerOptions {
  /** Tick interval. Defaults to 30s. Tests inject ~100ms. */
  tickMs?: number;
}

const DEFAULT_TICK_MS = 30_000;

function minuteKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly lastFired = new Map<string, string>();
  private readonly tickMs: number;

  constructor(
    private readonly store: RoutineStore,
    opts: SchedulerOptions = {},
  ) {
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  }

  /** Start ticking. Also runs one tick immediately so short-lived runs still fire. */
  start(dispatch: (routine: Routine) => Promise<void>): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick(dispatch);
    }, this.tickMs);
    void this.tick(dispatch);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Number of routines that have fired at least once (useful in tests). */
  firedCount(): number {
    return this.lastFired.size;
  }

  private async tick(dispatch: (routine: Routine) => Promise<void>): Promise<void> {
    const now = new Date();
    const key = minuteKey(now);
    let routines: Routine[];
    try {
      routines = this.store.list();
    } catch (err) {
      console.error(`scheduler: cannot list routines: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const routine of routines) {
      if (!routine.enabled) continue;
      let matches = false;
      try {
        matches = matchesCron(routine.cron, now);
      } catch {
        continue; // corrupt cron in store: skip loudly? No — skip quietly, list/toggle still work.
      }
      if (!matches) continue;
      if (this.lastFired.get(routine.id) === key) continue;
      this.lastFired.set(routine.id, key);
      try {
        await dispatch(routine);
      } catch (err) {
        console.error(
          `scheduler: dispatch of routine ${routine.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
