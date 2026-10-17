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

## v1.0 — Hardened, semantic, installable (this release)

- **Sandbox hardening:** `buildRunArgs()` applies `--cap-drop=ALL`,
  `--security-opt=no-new-privileges:true`, `--memory=1g`, `--cpus=1.0`,
  `--pids-limit=256`, `--tmpfs /tmp:rw,noexec,nosuid,size=256m` by default;
  limits configurable (`OMNI_SANDBOX_MEMORY` / `OMNI_SANDBOX_CPUS`);
  documented threat model in SANDBOX.md (what's mitigated, what's not —
  kernel exploits, side channels, egress are honest residual risks)
- **Vector memory:** `embed()` via any OpenAI-compatible `/embeddings`
  endpoint + `cosine()`; `SqliteMemoryStore.rememberVec/semanticRecall`
  (Float32-LE BLOBs, brute-force cosine — personal-scale honest);
  kernel `Agent` accepts opt-in `embedder`, injects top-k semantic recall
  and stores tool-result summaries as vectors (failures never break runs)
- **Handoff completion:** sub-agents now get identical wiring to top-level
  agents — skill-prompt injection + sandbox computer tools flow through
  `buildSubAgentWiring()` (the v0.3 limitation is gone); maxDepth=3 kept
- **Telegram inline approvals:** `ask` approvals arrive as Approve/Deny
  inline-keyboard buttons; `callback_query` handling resolves them, edits the
  message with the decision, answers the callback; `stop()` never strands a run
- **Installers & release:** `install.sh` (curl|bash, Linux/macOS, no sudo);
  `docs/INSTALL.md` + `docs/PUBLISH.md`; CLI published as `omni-agents`
  (name verified free 2026-10-17); `CHANGELOG.md`; everything at `1.0.0`

## v1.1 — "Better Than All": the experience layer (this release)

The closed giants win on experience, not architecture. v1.1 closes the four
experience gaps — each a direct answer to a rival's best weapon:

- **Watchers** (`@omni/watchers`): proactive observation — watch a URL, file,
  or command output on a cron; on change (hash diff + cooldown), the agent
  runs your task with the excerpt. First fetch is the baseline (no false
  positives). `omni watch add/list/remove/check/run`. Docs: WATCHERS.md.
  (Answers Dots' "proactive research".)
- **Docs/Spaces**: every agent gets a `docs/` workspace with `doc.write`,
  `doc.read`, `doc.list`, `doc.append` tools (policy-gated, path-traversal
  jailed); the web console gains a Docs tab with list + markdown rendering.
  (Answers OpenDots Spaces.)
- **Specialist packs** (`@omni/packs` + `packs/`): one-command expert agents —
  `researcher`, `inbox-triage`, `repo-watcher`, `meeting-prep` — each a
  validated `pack.json` (system prompt, tools, policy, skills, routines) with
  an honest `requires` setup checklist. `omni pack list/install`. Docs: PACKS.md.
  (Answers Dots' specialist dots.)
- **Group chat** (kernel `GroupStore` + `runGroupTurn`): multi-agent rooms —
  round-robin turns, `@mention` routing, `/done` early exit, `maxRounds`
  guard, per-agent policies never bypassed, JSONL history. `omni group
  create/list/chat`. Docs: GROUPS.md. (Answers Grok Bot group chats.)

## v1.2 — Voice + X (this release)

- **Voice** (`@omni/voice`): STT/TTS over OpenAI-compatible audio endpoints
  (zero deps, hand-rolled multipart); Telegram voice notes transcribed to
  text, optional audio replies via `sendAudio`; `OMNI_STT_*`/`OMNI_TTS_*`
  env config. Docs: VOICE.md.
- **X adapter** (`@omni/channels-x`): mentions polling + threaded replies over
  the X API v2 with hand-rolled OAuth 1.0a (node:crypto, zero deps); 429
  backoff, self-reply skip, `since_id` tracking; `omni x <id> [--poll N]`.
  Docs: CHANNELS.md (setup + automation-rules warning).
- **Web console mobile pass**: viewport + responsive CSS (single column,
  44px tap targets, sticky chat bar).
- **Killer demo** (`examples/killer-demo.md`): the "better than all"
  walkthrough — import a real Grok plugin, add watchers/docs/group chat.
- Honestly out: OpenAI-connector importer — connectors are OAuth app
  integrations with no portable export format, so there is nothing real to
  import; documented as a non-goal, not shipped as theater.

## v1.3 — Browser tool, Slack, provider router, X search (this release)

- **Browser tool** (`@omni/browser`, zero deps): hand-rolled CDP client over
  Node's built-in WebSocket + `CdpBrowserBackend` (open/snapshot/click/type
  via Page/DOM/Input/Accessibility domains) + `browser.*` tools on the
  gateway — write-class (ask by default), attached when `OMNI_BROWSER_CDP_URL`
  is set (`ws://…` or `http://host:9222` with `/json/list` discovery).
  `Dockerfile.browser` (headless Chromium, remote-debugging-port 9222) ships
  as documentation-as-code. Docs: BROWSER.md (incl. real-Chrome checklist and
  honest limits — no live-Chrome E2E on the build machine; web console doesn't
  attach browser tools yet).
- **Slack adapter** (`@omni/channels-slack`, zero deps): Events API webhook
  (node:http) with HMAC-SHA256 `v0=` signature verification (5-min tolerance),
  `url_verification` challenge handling, `app_mention` + human `message`
  routing, threaded `chat.postMessage` replies; `omni slack <id> [--port]`.
  Docs: CHANNELS.md (app setup, scopes, Events URL).
- **Provider router** (kernel): agent config gains `providers[]`
  (`{id, baseUrl, apiKeyEnv, models[]}`) + `routing[]` regex rules;
  `RoutingProvider` resolves `<id>:<model>` prefix → rule → models list →
  first entry, and falls back (max 2) on 429/5xx/network errors with a logged
  switch. Single-`model` configs keep working unchanged (back-compat).
- **X bulk search**: `XChannel.search()` over `GET /2/tweets/search/recent`
  (OAuth 1.0a, 429 backoff); `omni x-search "<query>" [--max N]`.
- Honestly out (stays out): realtime voice calls (theater without a telephony
  provider); hosted relay (local-first thesis).

## What's next (post-1.3)

- **v1.4: email channel + rich artifacts console** — bring-your-own-mailbox
  channel (the agent-owned-inbox primitive, done honestly); sandboxed iframe
  rendering of agent-produced HTML in the web console.
- Marketplace curation: signed plugin manifests, review queue, usage/cost tracking
- OpenDots dot importer; per-agent egress firewall; ANN vector index when
  personal-scale brute force stops being enough
- The "universal best tool" test: a new user goes from zero to a useful,
  memory-persisting, policy-guarded agent on their favorite channel in
  under five minutes — without reading docs.

Non-goals: Omni will not become a model lab. The kernel stays
provider-agnostic; intelligence comes from the model you plug in.
