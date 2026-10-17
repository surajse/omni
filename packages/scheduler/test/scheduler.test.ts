import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RoutineStore, type Routine } from '../src/routines.js';
import { Scheduler } from '../src/scheduler.js';

describe('Scheduler', () => {
  it('fires a * * * * * routine exactly once with a fast tick', async () => {
    const store = new RoutineStore(mkdtempSync(join(tmpdir(), 'omni-sched-')));
    store.add({ agentId: 'scout', cron: '* * * * *', task: 'tick' });
    store.add({ agentId: 'scout', cron: '* * * * *', task: 'disabled', enabled: false });

    const sched = new Scheduler(store, { tickMs: 100 });
    const fired: Routine[] = [];
    const dispatch = vi.fn(async (r: Routine) => {
      fired.push(r);
    });
    sched.start(dispatch);
    await new Promise((r) => setTimeout(r, 350));
    sched.stop();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(fired[0]?.task).toBe('tick');
    expect(sched.firedCount()).toBe(1);
  });

  it('does not fire routines whose cron does not match', async () => {
    const store = new RoutineStore(mkdtempSync(join(tmpdir(), 'omni-sched-')));
    // 04:04 on Feb 29 — essentially never matches in a short test window.
    store.add({ agentId: 's', cron: '4 4 29 2 *', task: 'leap' });
    const sched = new Scheduler(store, { tickMs: 50 });
    const dispatch = vi.fn(async () => {});
    sched.start(dispatch);
    await new Promise((r) => setTimeout(r, 200));
    sched.stop();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('survives dispatch errors and keeps ticking', async () => {
    const store = new RoutineStore(mkdtempSync(join(tmpdir(), 'omni-sched-')));
    store.add({ agentId: 's', cron: '* * * * *', task: 'boom' });
    const sched = new Scheduler(store, { tickMs: 100 });
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      errors.push(a);
    };
    try {
      sched.start(async () => {
        throw new Error('dispatch exploded');
      });
      await new Promise((r) => setTimeout(r, 250));
      sched.stop();
    } finally {
      console.error = orig;
    }
    expect(errors.length).toBeGreaterThan(0);
  });
});
