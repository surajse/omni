# Omni Roadmap

## v0.1 — Agent kernel (shipped)

- Provider-agnostic agent loop (OpenAI-compatible + mock)
- Tool gateway with sync/async handlers
- Policy engine: allow / ask / deny, wildcard rules, read-only defaults
- MCP stdio tool source with read-only heuristics
- SQLite-backed namespaced memory
- File-backed agent registry
- Plugin manifest spec (v1.0) + validator + example
- Channel abstraction + console channel
- `omni` CLI: init / list / chat / run / plugin validate

## v0.2 — Sandboxed computer + channels (this release)

- Per-agent Docker sandbox: container `omni-<id>` + persistent volume at `/home/agent`
- `computer.exec` / `computer.read_file` / `computer.write_file` tools (policy-gated)
- `ContainerRuntime` interface + `MockRuntime` (tests never need Docker)
- Telegram channel (Bot API long-polling, allowlist, auto-chunking)
- WhatsApp Cloud API channel (webhook verify + inbound/outbound via Graph API v21.0)
- Routine scheduler: 5-field cron matcher, JSON routine store, ticking daemon
  (`routine add/list/remove/run`; daemon auto-skips approvals, logged)
- Docs: CHANNELS.md, SANDBOX.md (incl. honest Docker-not-exercised-here note)
- `omni` CLI: routine, telegram, whatsapp, sandbox exec

## v0.3 — Skills, handoffs, web console (this release)

- `@omni/skills`: learn reusable skills from run transcripts (`omni learn`),
  `SkillManager` (`SKILL.md` + `skill.json`), deterministic step compression
  (3+ repeats collapse), prompt injection of learned skills
- Run transcripts: every `omni run` and web run saves JSONL to
  `~/.omni/agents/<id>/runs/` (also the input to `omni learn`)
- Agent-to-agent handoff: `agent.handoff` tool (write-class, policy-gated),
  depth-limited chains (default max 3), clean errors for unknown targets
- Web console (`@omni/web`, zero deps): `omni web` — chat with SSE live
  events, transcript viewer, and an Approve/Deny approval queue;
  binds 127.0.0.1 only, no auth by design (see docs/WEB.md)
- Docs: SKILLS.md, WEB.md

## v0.4 — Distribution: share everything, import from anywhere (shipped)

- `@omni/registry`: plugin registry — `index.json` format (version 1),
  local-dir and git-URL sources (`git clone --depth 1`),
  `search` / `install` / `list` / `remove`; bundled `registries/examples/`
  (`hello` + `echo` plugins)
- `@omni/importers`: real `.grok-plugin` importer (verified against
  xai-org/plugin-marketplace 2026-10-17) — `.grok-plugin/plugin.json` +
  `.mcp.json` + `skills/*/SKILL.md` → `omni.plugin.json` (per-server
  `discover: true` tools); auto-runs on `plugin install` for grok-format dirs
- `@omni/plugin-spec`: `mcp-http` source kind (`{url, headers?}`) + tool
  `discover?: boolean` (additive; manifestVersion stays `"1.0"`)
- Kernel: `McpHttpToolSource` (StreamableHTTPClientTransport) +
  `attachPluginManifest()`; `packAgent`/`unpackAgent` (agent packs:
  config + skills + routines + memory, secrets scrubbed at export)
- `@omni/teams`: filesystem team sharing — `init`/`publish`/`install`/
  `list`/`agents`, teams root defaults to `~/.omni/teams` (`OMNI_TEAMS_ROOT`
  override; point it at a shared git repo / synced folder)
- Hardening: `scrubSecrets()` (JSON / env / Bearer) applied in transcript
  save and memory `exportJson`; `omni doctor` diagnostics (always exit 0);
  `OMNI_WEB_TOKEN` for the web console (localhost-only by default)
- CLI: `plugin` / `agent export|import` / `team` / `doctor` commands

## v1.0 — The universal agent

- Sandbox escape review (per-agent egress policy, image digest pinning)
- Installers (one-command install per OS)
- Hosted relay (share agents without self-hosting)
- Vector memory (sqlite-vec, still local)
- Approvals over chat channels (Telegram/WhatsApp buttons)
- OpenDots dot importer; usage/cost tracking; signed plugin manifests

## v1.0 — The universal agent

- One agent, every surface: chat apps, voice, desktop, mobile, web
- Bring-your-own-model with automatic fallback and eval harness
- Hosted mode with the same policy engine and audit log
- The "universal best tool" test: a new user goes from zero to a useful,
  memory-persisting, policy-guarded agent on their favorite channel in
  under five minutes — without reading docs.

Non-goals: Omni will not become a model lab. The kernel stays
provider-agnostic; intelligence comes from the model you plug in.
