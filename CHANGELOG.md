# Changelog

All notable changes to Omni. Format: Keep a Changelog.

## [1.0.0] — 2026-10-17

**Hardened, semantic, installable.**

### Added
- Sandbox hardening: `--cap-drop=ALL`, `--security-opt=no-new-privileges:true`,
  `--memory=1g`, `--cpus=1.0`, `--pids-limit=256`, noexec `/tmp` tmpfs by
  default; configurable via constructor opts / `OMNI_SANDBOX_MEMORY` /
  `OMNI_SANDBOX_CPUS`; documented threat model (SANDBOX.md)
- Vector memory: `embed()` (OpenAI-compatible `/embeddings`) + `cosine()`;
  `SqliteMemoryStore.rememberVec/semanticRecall` (Float32-LE BLOBs,
  brute-force cosine, personal-scale); opt-in `embedder` on the kernel `Agent`
  (semantic recall injection + tool-result vector storage; failures never
  break runs)
- Handoff completion: sub-agents get identical wiring to top-level agents
  (skill-prompt injection + sandbox computer tools) via `buildSubAgentWiring()`
- Telegram inline approvals: Approve/Deny buttons, callback handling,
  message edit with the decision, clean shutdown semantics
- `install.sh` (curl|bash, Linux/macOS, no sudo); `docs/INSTALL.md`,
  `docs/PUBLISH.md`; CLI npm-ready as `omni-agents` (name verified free)

### Changed
- `HandoffOptions.makeDeps` may now return `{ config, deps }` (async allowed)
  so wiring can transform the sub-agent config
- Telegram message handling is fire-and-forget with in-flight tracking
  (the poll loop can no longer deadlock on approvals); `stop()` waits for
  handlers and resolves pending approvals as denied
- Everything bumped to `1.0.0`

## [0.4.0] — 2026-10-17

- `@omni/registry`: git/local plugin sources, search, one-command install
  (grok-format auto-convert), bundled `registries/examples/`
- `@omni/importers`: real `.grok-plugin` importer (format verified live from
  xai-org/plugin-marketplace); plugin-spec gains `mcp-http` + `discover`
- Kernel: `McpHttpToolSource`, `attachPluginManifest()`, `packAgent`/`unpackAgent`
- `@omni/teams`: filesystem team sharing (init/publish/install/list)
- Hardening: `scrubSecrets()` in transcripts + memory exports, `omni doctor`,
  `OMNI_WEB_TOKEN` for the web console

## [0.3.0] — 2026-10-17

- `@omni/skills`: learn reusable skills from run transcripts (`omni learn`)
- Agent-to-agent handoff: `agent.handoff` tool (policy-gated, maxDepth 3)
- Web console (`@omni/web`, zero deps): chat, SSE live events, transcript
  viewer, Approve/Deny approval queue; binds 127.0.0.1
- `omni run` persists JSONL transcripts

## [0.2.0] — 2026-10-17

- Per-agent Docker sandbox (`@omni/sandbox`): `ContainerRuntime`,
  `DockerRuntime`, `MockRuntime`, `computer.exec/read_file/write_file`
- Telegram channel (Bot API long-polling, allowlist)
- WhatsApp Cloud API channel (webhook verify + Graph API)
- Routine scheduler: 5-field cron, JSON store, daemon (`routine add/list/remove/run`)

## [0.1.0] — 2026-10-17

- Agent kernel: provider-agnostic run loop (`ModelProvider`,
  `OpenAICompatibleProvider`, `MockProvider`), `ToolGateway`, MCP stdio
  source, `PolicyEngine` (allow/ask/deny), `AgentRegistry`
- `SqliteMemoryStore` (node:sqlite, JSON export/import)
- `.omni-plugin` manifest spec v1.0 + validator
- `Channel` interface + `ConsoleChannel`; `omni` CLI
  (init/list/chat/run/plugin validate)
