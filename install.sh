#!/usr/bin/env bash
# Omni installer: https://github.com/surajse/omni
# Usage: curl -fsSL https://raw.githubusercontent.com/surajse/omni/main/install.sh | bash
# Or from a local checkout: ./install.sh
set -euo pipefail

REPO_URL="https://github.com/surajse/omni"
INSTALL_DIR="${OMNI_INSTALL_DIR:-$HOME/.omni-src}"
BIN_DIR="${OMNI_BIN_DIR:-$HOME/.local/bin}"

info() { printf 'omni: %s\n' "$*"; }
fail() { printf 'omni: ERROR: %s\n' "$*" >&2; exit 1; }

# 1. Node >= 22 ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  fail "node not found. Install Node.js 22+ from https://nodejs.org/ and re-run."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "node $NODE_MAJOR found; Omni needs Node.js >= 22."
fi
info "node $(node --version) OK"

# 2. pnpm ----------------------------------------------------------------------
if ! command -v pnpm >/dev/null 2>&1; then
  info "pnpm not found; installing via corepack..."
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@10 --activate >/dev/null 2>&1 || true
  fi
fi
if ! command -v pnpm >/dev/null 2>&1; then
  info "corepack unavailable; installing pnpm with npm (no sudo)..."
  npm install -g pnpm >/dev/null 2>&1 || fail "could not install pnpm; install it manually: https://pnpm.io/installation"
fi
info "pnpm $(pnpm --version) OK"

# 3. Source --------------------------------------------------------------------
if [ -f "./package.json" ] && [ -d "./packages/kernel" ] && [ -f "./pnpm-workspace.yaml" ]; then
  info "using current directory as the Omni source"
  SRC_DIR="$PWD"
else
  if [ ! -d "$INSTALL_DIR/.git" ]; then
    info "cloning $REPO_URL into $INSTALL_DIR"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" || fail "git clone failed"
  else
    info "updating existing checkout at $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only || info "pull failed; continuing with existing checkout"
  fi
  SRC_DIR="$INSTALL_DIR"
fi

# 4. Build ---------------------------------------------------------------------
info "installing dependencies (this may take a minute)..."
(cd "$SRC_DIR" && pnpm install --frozen-lockfile)
info "building..."
(cd "$SRC_DIR" && pnpm build)
(cd "$SRC_DIR" && node scripts/verify.mjs >/dev/null) && info "verify: typecheck + lint + tests green"

# 5. Link the CLI ---------------------------------------------------------------
mkdir -p "$BIN_DIR"
ln -sf "$SRC_DIR/apps/cli/dist/src/index.js" "$BIN_DIR/omni"
chmod +x "$BIN_DIR/omni"
info "linked $BIN_DIR/omni"

if ! command -v omni >/dev/null 2>&1; then
  info "NOTE: $BIN_DIR is not on your PATH."
  info "Add this to your shell profile: export PATH=\"\$HOME/.local/bin:\$PATH\""
else
  info "omni is on PATH: $(command -v omni)"
fi

info "done. Try: omni init --name Friday"
