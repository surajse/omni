# Changelog

All notable changes to Omni. Format: Keep a Changelog.

## [1.3.0] — 2026-10-17

**Browser tool, Slack, provider router, X search** — closes the CRITICAL gap
from the 2026-10-17 gap review (every rival had real browser automation;
Omni's sandbox was terminal-only).

### Added
- Browser tool (`@omni/browser`, zero deps): hand-rolled CDP client over
  Node's built-in WebSocket (framing, id matching, timeouts, event
  subscription — unit-tested against a fake socket), `CdpBrowserBackend`
  (`open` with load-event wait, `snapshot` as a pruned accessibility tree,
  `click`/`type` by AX node id via DOM quads, `screenshot`), and
  `browser.open` / `browser.snapshot` / `browser.click` / `browser.type`
  tools — all write-class (ask by default; browsing is network egress),
  attached when `OMNI_BROWSER_CDP_URL` is set (`ws://…` or
  `http://host:9222` via `/json/list` discovery). `Dockerfile.browser`
  (headless Chromium, `--remote-debugging-port=9222`) ships as
  documentation-as-code. Docs: BROWSER.md.
- Slack adapter (`@omni/channels-slack`, zero deps): Events API webhook with
  HMAC-SHA256 `v0=` signature verification (5-minute tolerance), automatic
  `url_verification` answers, `app_mention` + human `message` routing
  (bot/edit/delete noise ignored), threaded `chat.postMessage` replies;
  `omni slack <agent-id> [--port N]`; `omni doctor` gains Slack rows.
  Docs: CHANNELS.md (app setup: scopes `app_mentions:read`, `chat:write`,
  `im:history`; Events URL).
- Provider router (kernel): agent config gains `providers[]` and `routing[]`;
  `RoutingProvider` resolves `<providerId>:<model>` prefix → routing-rule
  regex → `models` list → first entry, and falls back (max 2) on 429/5xx and
  network errors, logging each switch. Non-retryable errors (400/401/…)
  fail fast. Single-provider configs keep working unchanged.
- X bulk search: `XChannel.search()` over `GET /2/tweets/search/recent`
  (OAuth 1.0a signed, 429 backoff); `omni x-search "<query>" [--max N]`
  prints `id · @author · created_at` + text.
- `omni doctor` gains `OMNI_BROWSER_CDP_URL` (+ Slack rows): names only,
  never values.

### Honestly out
- Realtime voice calls: without a real telephony provider this would be pure
  theater — stays out. Telegram voice messages cover ~80% of the use case.
- Hosted relay: contradicts the local-first thesis — stays out.

### Honest limits (carried forward)
- No live-Chrome E2E on the build machine (no Docker/Chromium): CDP
  protocol + backend logic are unit-tested (fake socket, stubbed
  connection); the real-Chrome checklist lives in docs/BROWSER.md.
- The web console (`omni web`) does not attach browser tools yet (its agent
  factory is synchronous); all CLI flows do, including handoff sub-agents.
- Slack/X/bulk-search exercised with mocked fetch only — needs real
  credentials on a live machine.

## [1.2.0] — 2026-10-17

**Voice + X.**

### Added
- Voice (`@omni/voice`, zero deps): `transcribe()` over OpenAI-compatible
  `/audio/transcriptions` (hand-rolled multipart) and `speak()` over
  `/audio/speech`; works with OpenAI, Groq, or a local Whisper server.
  `voiceConfigFromEnv()` reads `OMNI_STT_*`/`OMNI_TTS_*`; unset keys mean
  voice stays off. Docs: VOICE.md.
- Telegram voice messages (`@omni/channels-telegram`): inbound voice/audio
  notes are downloaded (`getFile`) and transcribed; with TTS configured,
  replies go back as `sendAudio` mp3 with the text as caption (1024-char cap).
  Without voice config, the bot politely declines voice notes.
- X adapter (`@omni/channels-x`, zero deps): hand-rolled OAuth 1.0a
  (HMAC-SHA1, node:crypto), mentions polling + threaded replies over the X
  API v2, 429 backoff, self-reply skip, `since_id` tracking;
  `omni x <id> [--poll N]` with friendly missing-credential errors.
  Docs: CHANNELS.md (includes automation-rules warning).
- Web console mobile pass: viewport + responsive CSS (single column under
  720px, 44px tap targets, sticky chat bar).
- Killer demo (`examples/killer-demo.md`): the "better than all" walkthrough —
  import a real Grok plugin, then add watchers/docs/group chat on top.

### Honestly out
- OpenAI-connector importer: connectors are OAuth app integrations with no
  portable export format — nothing real to import. Documented as a non-goal,
  not shipped as theater.

## [1.1.0] — 2026-10-17

**"Better Than All": the experience layer.**

### Added
- Watchers (`@omni/watchers`): proactive observation of URLs, files, and
  command output on a cron; hash-diff + cooldown-gated change detection;
  first fetch stores the baseline (no false positives); `omni watch
  add/list/remove/check/run`; daemon auto-skips approvals like the routine
  daemon. Docs: WATCHERS.md.
- Docs/Spaces: per-agent `docs/` workspace with `doc.write/read/list/append`
  tools (write-class tools policy-gated, all paths jailed against traversal);
  web console Docs tab (list + markdown rendering). Wired into every agent
  stack: CLI, handoff sub-agents, and web.
- Specialist packs (`@omni/packs` + `packs/`): `researcher`, `inbox-triage`,
  `repo-watcher`, `meeting-prep` — validated `pack.json` format (system
  prompt, tools, policy, skills, routines) with honest `requires` checklists;
  `omni pack list/install [--as]`; `OMNI_PACKS_DIR` override. Docs: PACKS.md.
- Group chat (kernel): `GroupStore` (filesystem-backed rooms + JSONL
  history), `runGroupTurn` (round-robin + `@mention` routing, `/done` early
  exit, `maxRounds` guard, per-agent policies intact); `omni group
  create/list/chat`. Docs: GROUPS.md.

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
