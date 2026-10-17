# Omni Browser Tool (v1.3)

The browser tool closes the one capability every rival demos that Omni lacked:
real browser automation. The agent gets four tools — `browser.open`,
`browser.snapshot`, `browser.click`, `browser.type` — backed by a real
headless Chromium driven over the Chrome DevTools Protocol (CDP). Zero
external npm dependencies: the CDP client (`@omni/browser`) is hand-rolled
over Node's built-in WebSocket.

## Quickstart

1. Start a headless Chromium with remote debugging (see
   `packages/browser/Dockerfile.browser`, or any Chromium you already run):

   ```bash
   docker build -f packages/browser/Dockerfile.browser -t omni-browser .
   docker run -d --name omni-browser -p 9222:9222 omni-browser
   ```

2. Point Omni at it:

   ```bash
   export OMNI_BROWSER_CDP_URL=http://localhost:9222
   ```

   `ws://…` URLs work too (used verbatim). An `http(s)://host:port` value is
   resolved through the `/json/list` discovery page to a page-target WebSocket.

3. Run any agent command (`omni run`, `omni chat`, `omni telegram`, …) — when
   `OMNI_BROWSER_CDP_URL` is set, the `browser.*` tools attach automatically.
   When unset or unreachable, Omni warns once and continues without them.

## How the agent sees the web

- `browser.open <url>` — navigates (http/https only) and waits for the page
  load event (30s timeout). This is **network egress**.
- `browser.snapshot` — returns the page as a pruned accessibility tree:
  `[12] button "Sign in"`. Capped at 200 nodes / 8000 chars so context stays
  small. Ignored (non-semantic) nodes are filtered out.
- `browser.click <node>` / `browser.type <node> <text>` — act on a node id
  from the latest snapshot. Clicks resolve the AX node to a DOM object,
  scroll it into view, and dispatch press+release at the quad center. Node ids
  expire on the next snapshot (stale ids get a clear "take a fresh snapshot"
  error, not a silent mis-click).
- Screenshots are available in the backend (`Page.captureScreenshot`) but are
  **not** exposed as a tool in v1.3 — the AX tree is the agent's eyes, and
  images would explode context. Revisit if a vision-capable default model
  becomes the norm.

## Policy

All four tools are **write-class** (policy default: `ask`) because browsing is
network egress. An agent config can allowlist them, e.g.:

```json
{ "policy": [{ "match": "browser.*", "effect": "allow" }] }
```

For unattended channels (`omni telegram`, `omni x`, …) think about whether you
want the agent opening arbitrary URLs without you watching — the default asks.

## Real-Chrome checklist (first run on a live machine)

`@omni/browser` is unit-tested against a stubbed CDP connection (protocol
framing, id matching, timeouts, AX pruning, click/type dispatch) — but no
live Chrome or Docker exists on the build machine, so do this once:

1. `docker run -d --name omni-browser -p 9222:9222 omni-browser` (from the
   Dockerfile above).
2. `curl -s http://localhost:9222/json/list` — expect a JSON array with a
   `page` target carrying a `webSocketDebuggerUrl`.
3. `export OMNI_BROWSER_CDP_URL=http://localhost:9222`
4. `omni doctor` — the `OMNI_BROWSER_CDP_URL` row should read "set".
5. `omni run <id> "open https://example.com and tell me the main heading"` —
   approve the `browser.open` prompt, then `browser.snapshot`, and confirm
   the agent reads `[N] heading "Example Domain"`.

## Honest limits

- **No live-Chrome E2E was exercised here** (no Docker/Chromium on the build
  VM). Protocol + backend logic is unit-tested; the checklist above is the
  remaining proof.
- The AX tree is the only page representation — heavily canvas/WebGL pages
  are mostly invisible to the agent.
- No JavaScript evaluation tool is exposed (deliberate: keeps the tool
  surface small and auditable).
- The web console (`omni web`) does **not** attach browser tools yet (its
  agent factory is synchronous); all CLI flows do, including handoff
  sub-agents.
- `--no-sandbox` in the Dockerfile is required to run Chromium as root in
  Docker. Keep port 9222 on localhost; the policy engine (ask-by-default)
  is the approval boundary, not the container.
