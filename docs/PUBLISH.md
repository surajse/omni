# Publishing `omni-agents` to npm

The CLI is publish-ready as **`omni-agents`** (verified free on the npm
registry 2026-10-17 via `npm view omni-agents` → 404). The package is
**not published yet** — publishing needs the maintainer's `npm login`.

## What's already in place

`apps/cli/package.json` carries everything npm needs:

- `name: omni-agents`, `version: 1.0.0`, `license: MIT`
- `bin: { omni: dist/src/index.js }` (shebang present in source)
- `files: ["dist"]`, `repository`, `homepage`, `keywords`
- `publishConfig: { access: public }`
- `engines: { node: ">=22" }`

## The one wrinkle: workspace dependencies

`omni-agents` depends on `@omni/*` workspace packages (`workspace:*`).
`pnpm publish` rewrites `workspace:*` to the real version (`1.0.0`), but npm
cannot resolve `@omni/*` unless those packages are published too. So the
publish order matters.

## Exact publish steps (maintainer)

```sh
# 0. One-time: log in (interactive — needs the maintainer)
npm login

# 1. Check the @omni scope situation. If the scope is taken, either claim it
#    or publish the packages unscoped and update the CLI's dependencies.
npm view @omni/kernel  # 404 = free

# 2. Publish the library packages first (dependency order), from the repo root:
for p in plugin-spec channels kernel memory sandbox scheduler skills \
         channels-telegram channels-whatsapp web registry importers teams; do
  (cd packages/$p && pnpm publish --access public --no-git-checks)
done
# (adjust the loop if some packages live under apps/)

# 3. Sanity-check what would ship for the CLI (no upload):
(cd apps/cli && pnpm pack --dry-run)

# 4. Publish the CLI:
(cd apps/cli && pnpm publish --access public --no-git-checks)

# 5. Verify:
npm view omni-agents version   # → 1.0.0
npx --yes omni-agents --help   # bin wiring works from a clean install
```

## After publishing

- Tag the release: `git tag v1.0.0 && git push origin v1.0.0`
- Attach `install.sh` + the changelog to a GitHub Release
- Update `docs/INSTALL.md` method 3 (`npm install -g omni-agents`)

## If `omni-agents` gets taken before we publish

Next candidates, in order (all unchecked — verify with `npm view <name>`):
`omni-agent`, `omniagent`, `open-omni`. The bin name (`omni`) is unaffected
by the package name.
