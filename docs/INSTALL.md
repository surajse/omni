# Installing Omni

Three ways, fastest first.

## 1. One-command install (Linux / macOS)

```sh
curl -fsSL https://raw.githubusercontent.com/surajse/omni/main/install.sh | bash
```

This checks Node ≥ 22, installs pnpm if missing (via corepack), clones the
repo to `~/.omni-src`, runs `pnpm install`, `pnpm build`, and the full
`verify` gate (typecheck + lint + tests), then symlinks `omni` into
`~/.local/bin`. No sudo, no root — everything lives in your home directory.

Set `OMNI_INSTALL_DIR` / `OMNI_BIN_DIR` to override the defaults.

## 2. Manual install

Requirements: **Node.js ≥ 22**, **pnpm ≥ 10**, **git**.

```sh
git clone https://github.com/surajse/omni
cd omni
pnpm install
pnpm build
node scripts/verify.mjs   # typecheck + lint + tests — all green before you trust it
```

Then either use it in place:

```sh
pnpm exec omni init --name Friday
```

or link it onto your PATH:

```sh
ln -s "$PWD/apps/cli/dist/src/index.js" ~/.local/bin/omni
export PATH="$HOME/.local/bin:$PATH"
```

## 3. npm (when published)

`omni-agents` is the reserved package name (verified free 2026-10-17).
Until the first `npm publish` lands (see `docs/PUBLISH.md`), use method 1 or 2.

## Docker (only needed for sandboxes)

The per-agent computer (`computer.exec` / `computer.read_file` /
`computer.write_file`) needs the **Docker CLI + a running daemon**:

- Linux: https://docs.docker.com/engine/install/
- macOS: Docker Desktop, or `brew install --cask docker`

Everything else — agents, memory, scheduler, Telegram/WhatsApp channels,
web console — works without Docker. When Docker is missing, Omni warns and
continues without computer tools (`MockRuntime` covers tests).

## First run (five minutes, no docs)

```sh
omni init --name Friday          # create your first agent
omni run friday "remember that my favorite color is blue"
omni run friday "what is my favorite color?"   # memory persists

# Give it a recurring job:
omni routine add friday "0 9 * * *" "summarize yesterday's tech news"
omni routine run &               # daemon; Ctrl+C to stop

# Talk to it from your browser:
omni web                         # → http://127.0.0.1:8080

# Talk to it from Telegram (needs a bot token from @BotFather):
export TELEGRAM_BOT_TOKEN=...
omni telegram friday              # approvals arrive as Approve/Deny buttons

# Check the patient:
omni doctor
```

To use a real model instead of the mock, set:

```sh
export OMNI_API_KEY=...          # any OpenAI-compatible key
export OMNI_BASE_URL=https://api.openai.com/v1   # or Groq, xAI, Ollama, …
export OMNI_MODEL=gpt-4o-mini
```

Keys live in env vars only — never in configs, logs, or commits.
