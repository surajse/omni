# Omni — the universal open agent platform

**One agent. Every model. Every channel. Your machine.**

Omni is an open-source platform for agents that work everywhere: a
provider-agnostic agent kernel with explicit allow/ask/deny tool policies,
MCP tool servers, per-agent Docker computers, persistent + vector memory,
skills learned from demonstration, agent-to-agent handoff, group chat rooms,
proactive watchers, per-agent document workspaces, one-command specialist
packs, a plugin registry (including a real `.grok-plugin` importer), and
channels spanning console, web, Telegram, and WhatsApp. No vendor lock-in,
no mandatory cloud, no subscription meter.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/surajse/omni/main/install.sh | bash
# → omni init --name Friday
```

Or manually: `git clone https://github.com/surajse/omni && cd omni &&
pnpm install && pnpm build`. Full guide: [docs/INSTALL.md](docs/INSTALL.md).

## Quickstart (from source)

Requirements: Node >= 22, pnpm >= 10.

```sh
pnpm install
node scripts/verify.mjs   # typecheck + lint + tests, all green
pnpm build                # compile to dist/

# Create an agent, list it, and run a task
pnpm exec omni init --name "Friday"
pnpm exec omni list
pnpm exec omni chat friday        # /quit to exit
pnpm exec omni run friday "remember that my favorite color is blue, then tell me the time"
```

## Environment variables

| Variable        | Purpose                                              |
| --------------- | ---------------------------------------------------- |
| `OMNI_API_KEY`  | API key for an OpenAI-compatible chat endpoint       |
| `OMNI_BASE_URL` | Endpoint base URL (default `https://api.openai.com/v1`) |
| `OMNI_MODEL`    | Model name (default `gpt-4o-mini`)                   |
| `OMNI_SANDBOX_IMAGE` | Docker image for agent sandboxes (default `ubuntu:24.04`) |
| `OMNI_SANDBOX_MEMORY` | Sandbox memory limit (default `1g`) |
| `OMNI_SANDBOX_CPUS` | Sandbox CPU limit (default `1.0`) |
| `OMNI_EMBED_MODEL` | Embedding model name — enables vector memory when set with `OMNI_EMBED_API_KEY` |
| `OMNI_EMBED_API_KEY` | API key for the embeddings endpoint |
| `OMNI_EMBED_BASE_URL` | Embeddings base URL (default `https://api.openai.com/v1`) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather                |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user ids (default: all) |
| `WHATSAPP_TOKEN` | WhatsApp Cloud API access token                    |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Business phone number id            |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verify token (your choice)             |
| `WHATSAPP_PORT` | Webhook listen port (default `3000`)                 |
| `OMNI_WEB_PORT` | Web console port (default `8080`; `omni web --port` overrides) |
| `OMNI_WEB_TOKEN` | Optional web console token — when set, every `/` and `/api/*` request needs `?token=` (set one if you bind wider than localhost) |
| `OMNI_TEAMS_ROOT` | Teams root dir (default `~/.omni/teams`); point at a shared git repo / synced folder |
| `OMNI_PACKS_DIR` | Specialist packs dir (default: the repo's `packs/`) |

Without `OMNI_API_KEY` the CLI uses a scripted mock provider (useful for
demos and tests). Copy `.env.example` to `.env` for local use — never commit
real keys.

## v0.2: computer, channels, schedules

```sh
# Give the agent its own computer (Docker required)
omni sandbox exec friday "ls -la /home/agent"

# Scheduled routines (5-field cron) — daemon auto-skips approvals, logged
omni routine add friday "0 9 * * 1-5" "Summarize my inbox and draft replies"
omni routine list
omni routine run

# Serve the agent on Telegram / WhatsApp
omni telegram friday
omni whatsapp friday --port 3000
```

See [docs/CHANNELS.md](docs/CHANNELS.md) (BotFather + WhatsApp setup) and
[docs/SANDBOX.md](docs/SANDBOX.md) (Docker model + security notes).

## v0.3: skills, handoffs, web console

```sh
# Learn a skill from the agent's last run — it becomes part of its prompt
omni run friday "list unread messages and archive the newsletters"
omni learn friday triage-inbox "Triage the inbox: list unread, archive newsletters"

# Agents can delegate: add agent.handoff to a specialist's tools, then
omni run friday "hand the research task to scout"

# Web console: chat with live events, transcripts, and an approval queue
omni web                  # http://127.0.0.1:8080 (local-only, no auth)
```

Every `omni run` now saves its transcript to `~/.omni/agents/<id>/runs/`
(the input to `omni learn`). See [docs/SKILLS.md](docs/SKILLS.md) and
[docs/WEB.md](docs/WEB.md).

## v0.4: plugin registry, grok importer, agent packs, teams

```sh
# Find and install plugins — Omni-native or .grok-plugin (auto-converted)
omni plugin source add examples ./registries/examples
omni plugin search calcom
omni plugin install calcom

# Export a whole agent (config + skills + routines + memory) and share it
omni agent export friday --out friday.omnipack.json
omni agent import friday.omnipack.json --as friday-2

# Teams: publish packs to a shared folder (git repo / synced dir via OMNI_TEAMS_ROOT)
omni team init research-crew
omni team publish friday --team research-crew
omni team install research-crew friday --as friday-2

# Diagnostics — always exits 0
omni doctor
```

Secrets are scrubbed before transcripts are saved and before memory is
exported (`[REDACTED]`); `omni doctor` only prints env var *names*, never
values. The web console takes an optional `OMNI_WEB_TOKEN` (`?token=` on
every request) — set one if you ever bind wider than localhost.
See [docs/REGISTRY.md](docs/REGISTRY.md), [docs/TEAMS.md](docs/TEAMS.md),
[docs/PLUGIN_SPEC.md](docs/PLUGIN_SPEC.md).

## v1.0: hardened, semantic, installable

```sh
# Hardened sandboxes: cap-drop=ALL, no-new-privileges, 1g/1.0 CPU, noexec /tmp
omni sandbox exec friday "ls -la /home/agent"
OMNI_SANDBOX_MEMORY=2g omni run friday "analyze this log"

# Vector memory: semantic recall over everything the agent has done
export OMNI_EMBED_MODEL=text-embedding-3-small OMNI_EMBED_API_KEY=...
omni run friday "what did we conclude about the deploy last week?"

# Sub-agents now get the full wiring: skills + sandbox, like top-level agents
omni run friday "hand the research task to scout"

# Telegram approvals arrive as Approve/Deny buttons in the chat
omni telegram friday
```

See [docs/SANDBOX.md](docs/SANDBOX.md) (threat model), [CHANGELOG.md](CHANGELOG.md).

## v1.1: "Better Than All" — watchers, docs, packs, group chat

```sh
# Watchers: proactive observation — agent acts only when something changes
omni watch add friday "url:https://example.com/product" --every "*/15 * * * *" \
  --task "Summarize what changed and tell me if the price moved." --cooldown 120
omni watch check <watch-id>   # one-shot: CHANGED/unchanged + excerpt
omni watch run                # daemon mode

# Docs: every agent gets a document workspace (also in the web console's Docs tab)
omni run friday "research vector databases and save the brief with doc.write"

# Specialist packs: one-command expert agents
omni pack list
omni pack install researcher --as scout

# Group chat: multiple agents, one room (@mentions route turns, /done ends)
omni group create launch-team scout writer
omni group chat launch-team
```

See [docs/WATCHERS.md](docs/WATCHERS.md), [docs/PACKS.md](docs/PACKS.md),
[docs/GROUPS.md](docs/GROUPS.md).

## Repository layout

```
packages/kernel/            Agent loop, providers, tool gateway, policy engine, MCP sources, registry, handoff, packs, docs tools, group chat
packages/memory/            SQLite key/value + vector memory (embeddings client, cosine)
packages/plugin-spec/       Plugin manifest schema + validator (+ example)
packages/channels/          Channel abstraction + console channel
packages/sandbox/           Per-agent Docker computers (hardened) + computer-use tools
packages/channels-telegram/ Telegram Bot API channel (long-polling, inline approvals)
packages/channels-whatsapp/ WhatsApp Cloud API channel (webhook server)
packages/scheduler/         Cron matcher, routine store, ticking scheduler
packages/skills/            Learn skills from transcripts, manage them, inject into prompts
packages/registry/          Plugin registry: sources, search, one-command installs
packages/importers/         .grok-plugin → .omni-plugin importer (real format)
packages/teams/             Filesystem team sharing for agent packs
packages/watchers/          Proactive observation: fetch targets on cron, diff, notify on change
packages/packs/             Specialist packs: one-command expert agents (researcher, inbox-triage, …)
packs/                      The four flagship pack definitions
apps/cli/                   `omni` command-line interface (npm: omni-agents)
apps/web/                   Web console: node:http + SSE chat UI with approval queue + docs tab
docs/                       Architecture, install, publish, plugin spec, security, roadmap, …
install.sh                  One-command installer (Linux/macOS, no sudo)
```

## Design principles

- **AI proposes; policy decides.** Every tool call passes through an
  explicit allow/ask/deny policy. Reads run freely by default; writes ask.
- **No vendor lock-in.** Any OpenAI-compatible endpoint works; the mock
  provider keeps everything testable offline.
- **Evidence over vibes.** Plugin capabilities are declared in a manifest
  and validated; MCP tools are labeled read-only by convention and policy.

## License

MIT — see [LICENSE](LICENSE).
