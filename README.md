# Omni — the universal open agent platform

Omni is an open-source platform for building agents that work everywhere:
one agent kernel, pluggable models, policy-gated tools, MCP servers,
persistent memory, and channels (console today, chat apps tomorrow).

**v0.1 scope: the agent kernel.** A provider-agnostic agent loop with
explicit tool policies (allow / ask / deny), a file-backed agent registry,
SQLite memory, an MCP stdio tool source, a plugin manifest spec, a console
channel, and a CLI to drive it all. See [docs/ROADMAP.md](docs/ROADMAP.md)
for where this is going.

## Quickstart

Requirements: Node >= 22, pnpm >= 10.

```sh
pnpm install
node scripts/verify.mjs   # typecheck + lint + tests, all green
pnpm build                # compile to dist/

# Create an agent, list it, and run a task
node apps/cli/dist/src/index.js init --name "Friday"
node apps/cli/dist/src/index.js list
node apps/cli/dist/src/index.js chat friday        # /quit to exit
node apps/cli/dist/src/index.js run friday "remember that my favorite color is blue, then tell me the time"

# Validate a plugin manifest
node apps/cli/dist/src/index.js plugin validate packages/plugin-spec/plugins/examples/hello.omni-plugin.json
```

Once built, the CLI is also available as `pnpm exec omni …`.

## Environment variables

| Variable        | Purpose                                              |
| --------------- | ---------------------------------------------------- |
| `OMNI_API_KEY`  | API key for an OpenAI-compatible chat endpoint       |
| `OMNI_BASE_URL` | Endpoint base URL (default `https://api.openai.com/v1`) |
| `OMNI_MODEL`    | Model name (default `gpt-4o-mini`)                   |
| `OMNI_SANDBOX_IMAGE` | Docker image for agent sandboxes (default `ubuntu:24.04`) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather                |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user ids (default: all) |
| `WHATSAPP_TOKEN` | WhatsApp Cloud API access token                    |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Business phone number id            |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verify token (your choice)             |
| `WHATSAPP_PORT` | Webhook listen port (default `3000`)                 |

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

## Repository layout

```
packages/kernel/            Agent loop, providers, tool gateway, policy engine, MCP source, registry
packages/memory/            SQLite-backed namespaced memory store
packages/plugin-spec/       Plugin manifest schema + validator (+ example)
packages/channels/          Channel abstraction + console channel
packages/sandbox/           Per-agent Docker computers + computer-use tools
packages/channels-telegram/ Telegram Bot API channel (long-polling)
packages/channels-whatsapp/ WhatsApp Cloud API channel (webhook server)
packages/scheduler/         Cron matcher, routine store, ticking scheduler
apps/cli/                   `omni` command-line interface
docs/                       Architecture, plugin spec, security model, roadmap, channels, sandbox
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
