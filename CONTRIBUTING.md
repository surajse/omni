# Contributing to Omni

## Setup

```sh
pnpm install
node scripts/verify.mjs
```

`verify` runs three stages in order — `tsc -b` (project references),
`eslint`, `vitest run` — and stops at the first failure. Keep it green.

## Conventions

- TypeScript strict, ESM (`"type": "module"`), Node >= 22.
- `module`/`moduleResolution`: `NodeNext`; use `.js` suffixes on relative
  imports in sources.
- Packages declare only real runtime dependencies; cross-package deps are
  `workspace:*`. Dev tools live at the repo root.
- No `any` (eslint enforces it); prefer `unknown` + narrowing.
- No secrets in code, tests, or committed files. `.env.example` holds
  placeholder keys only.
- Tests live in `test/` next to `src/`, named `*.test.ts`, and run via the
  root vitest config (workspace packages are aliased to `src/`).

## Commits

Small, focused commits with a clear message (`area: what changed`).
Do not commit `dist/`, `node_modules/`, or `.env`.

## Pull requests

Describe what changed, why, and how you verified it (`node scripts/verify.mjs`
output). New tools or policy behavior must come with tests.
