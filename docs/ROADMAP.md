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

## What's next (post-1.0)

- Hosted relay: share agents without self-hosting (same policy engine + audit log)
- Mobile app (the agent in your pocket, on your server)
- Marketplace curation: signed plugin manifests, review queue, usage/cost tracking
- OpenDots dot importer; per-agent egress firewall; ANN vector index when
  personal-scale brute force stops being enough
- The "universal best tool" test: a new user goes from zero to a useful,
  memory-persisting, policy-guarded agent on their favorite channel in
  under five minutes — without reading docs.

Non-goals: Omni will not become a model lab. The kernel stays
provider-agnostic; intelligence comes from the model you plug in.
