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

## v0.3 — Trust hardening + teams

- Sandbox hardening: per-agent egress network policy, image digest pinning by default
- Approvals over the channel (approve/deny buttons in Telegram/WhatsApp, not just console)
- Plugin loader in the CLI (install from manifest, `mcp-stdio` supervision)
- Memory: semantic recall (sqlite-vec, still local), per-agent export/import commands
- Multi-agent: sub-agents, handoffs, shared task state

## v0.4 — Distribution

- `.omni-plugin` registry (git-based index)
- `.grok-plugin` importer (install rivals' plugins into Omni agents)
- OpenDots dot importer
- Usage/cost tracking per agent and per tool
- Signed plugin manifests (provenance)

## v1.0 — The universal agent

- One agent, every surface: chat apps, voice, desktop, mobile, web
- Bring-your-own-model with automatic fallback and eval harness
- Hosted mode with the same policy engine and audit log
- The "universal best tool" test: a new user goes from zero to a useful,
  memory-persisting, policy-guarded agent on their favorite channel in
  under five minutes — without reading docs.

Non-goals: Omni will not become a model lab. The kernel stays
provider-agnostic; intelligence comes from the model you plug in.
