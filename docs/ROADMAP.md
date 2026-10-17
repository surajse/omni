# Omni Roadmap

## v0.1 — Agent kernel (this release)

- Provider-agnostic agent loop (OpenAI-compatible + mock)
- Tool gateway with sync/async handlers
- Policy engine: allow / ask / deny, wildcard rules, read-only defaults
- MCP stdio tool source with read-only heuristics
- SQLite-backed namespaced memory
- File-backed agent registry
- Plugin manifest spec (v1.0) + validator + example
- Channel abstraction + console channel
- `omni` CLI: init / list / chat / run / plugin validate

## v0.2 — Sandboxed computer + channels

- Sandboxed tool execution (deny-by-default filesystem/network scopes)
- Real channels: Telegram, web chat widget; channel permission mapping
- Plugin loader in the CLI (install from manifest, `mcp-stdio` supervision)
- Approvals over the channel (not just console y/n)
- Memory: semantic recall, per-agent export/import commands

## v0.3 — Teams and sharing

- Multi-agent runs: sub-agents, handoffs, shared task state
- Signed plugin marketplace entries (provenance for manifests)
- Usage/cost tracking per agent and per tool

## v1.0 — The universal agent

- One agent, every surface: chat apps, voice, desktop, mobile, web
- Bring-your-own-model with automatic fallback and eval harness
- Hosted mode with the same policy engine and audit log
- The "universal best tool" test: a new user goes from zero to a useful,
  memory-persisting, policy-guarded agent on their favorite channel in
  under five minutes — without reading docs.

Non-goals: Omni will not become a model lab. The kernel stays
provider-agnostic; intelligence comes from the model you plug in.
