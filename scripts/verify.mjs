#!/usr/bin/env node
// Full verification pipeline: typecheck -> lint -> test.
// Prints PASS/FAIL per stage and exits non-zero on the first failure.
import { spawnSync } from 'node:child_process';

const stages = [
  { name: 'typecheck (tsc -b)', cmd: 'pnpm', args: ['exec', 'tsc', '-b'] },
  {
    name: 'lint (eslint)',
    // Run through a shell so packages/*/src globs expand exactly like `pnpm lint`.
    shell: 'pnpm exec eslint packages/*/src apps/*/src scripts/verify.mjs',
  },
  { name: 'test (vitest run)', cmd: 'pnpm', args: ['exec', 'vitest', 'run'] },
];

let failed = false;
for (const stage of stages) {
  console.log(`\n=== ${stage.name} ===`);
  const res =
    'shell' in stage
      ? spawnSync(stage.shell, { stdio: 'inherit', shell: true })
      : spawnSync(stage.cmd, stage.args, { stdio: 'inherit', shell: false });
  if (res.status === 0) {
    console.log(`PASS: ${stage.name}`);
  } else {
    console.log(`FAIL: ${stage.name} (exit code ${res.status})`);
    failed = true;
    break;
  }
}

if (!failed) console.log('\nAll stages passed.');
process.exit(failed ? 1 : 0);
