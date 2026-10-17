# Publishing to npm

## Status (verified 2026-10-17)

- **`omni-agents`** — name is FREE (`npm view omni-agents` → 404)
- **`@omni/*` scope** — FREE (`npm view @omni/kernel` → 404)
- All 20 publishable packages at **1.4.0** (`packages/*` × 18 + `apps/web` + `apps/cli`); repo root is `private: true` so it is skipped
- `dist/` is built (`node scripts/verify.mjs` green); every package has `files` configured

## What's already in place

- `apps/cli/package.json`: `name: omni-agents`, `bin: { omni: dist/src/index.js }` (shebang in source), `files: ["dist"]`, `publishConfig: { access: public }`, `engines: { node: ">=22" }`, repository/homepage/keywords
- `pnpm publish` automatically rewrites `workspace:*` dependencies to the real version (1.4.0), so no manual version juggling is needed

## Exact steps (maintainer — step 0 is interactive and needs you)

```sh
# 0. One-time login (interactive — only you can do this)
npm login

# 1. Re-verify the names are still free (cheap — do it right before publishing)
npm view omni-agents version   # expect 404
npm view @omni/kernel version  # expect 404

# 2. Sanity-check what the CLI tarball would contain (no upload)
(cd apps/cli && pnpm pack --dry-run)

# 3. Publish everything in dependency order (root is private → skipped automatically)
pnpm -r publish --access public --no-git-checks
# → 18 × packages/* + apps/web + apps/cli = 20 packages, topological order,
#   each workspace:* dep rewritten to 1.4.0

# 4. Verify from a clean state
npm view omni-agents version       # → 1.4.0
npx --yes omni-agents@1.4.0 --help # bin wiring works from a clean install
```

## After publishing

- Tag the release: `git tag v1.4.0 && git push origin v1.4.0`
- Create a GitHub Release for the tag; attach `install.sh` and the CHANGELOG notes
- Update `docs/INSTALL.md` method 3 to `npm install -g omni-agents`

## If a name gets taken before we publish

Next candidates, in order (verify each with `npm view <name>` → expect 404):
`omni-agent`, `omniagent`, `open-omni`. The bin name (`omni`) is unaffected by the package name.
