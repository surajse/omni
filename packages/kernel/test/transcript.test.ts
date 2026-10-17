import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunRecorder } from '../src/transcript.js';

describe('RunRecorder', () => {
  it('records events, exposes the tool-call sequence, and round-trips JSONL', () => {
    const rec = new RunRecorder();
    rec.onEvent({ type: 'text', text: 'hello' });
    rec.onEvent({
      type: 'tool-call',
      call: { id: 'c1', name: 'get_time', arguments: {} },
    });
    rec.onEvent({ type: 'done', output: 'hello' });

    expect(rec.toolCalls()).toEqual([{ name: 'get_time', args: {} }]);

    const dir = mkdtempSync(join(tmpdir(), 'omni-transcript-test-'));
    const path = rec.save(dir, 'run-1');
    expect(path.endsWith('runs/run-1.jsonl')).toBe(true);

    const loaded = RunRecorder.loadFile(path);
    expect(loaded).toHaveLength(3);
    expect(loaded[0]!.seq).toBe(0);
    expect(loaded[1]!.event.type).toBe('tool-call');
    expect(loaded[2]!.event.type).toBe('done');
  });

  it('latestFile returns the newest run or null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-transcript-test-'));
    expect(RunRecorder.latestFile(dir)).toBeNull();
    const rec = new RunRecorder();
    rec.onEvent({ type: 'done', output: 'x' });
    rec.save(dir, '2026-01-01T00-00-00');
    rec.save(dir, '2026-01-02T00-00-00');
    expect(RunRecorder.latestFile(dir)!.endsWith('2026-01-02T00-00-00.jsonl')).toBe(true);
  });

  it('sanitizes unsafe run ids in file names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-transcript-test-'));
    const rec = new RunRecorder();
    const path = rec.save(dir, '../../evil');
    expect(path).not.toContain('..');
  });
});
