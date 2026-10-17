# Omni Web Console

A zero-dependency web UI for your agents: chat with live event streaming,
inspect run transcripts, and approve or deny tool calls from the browser.

```sh
omni web                  # http://127.0.0.1:8080
omni web --port 9000      # custom port (or OMNI_WEB_PORT env)
```

## Tour

- **Agent picker + chat box** — pick an agent, send a message. The run starts
  in the background; you get a run id immediately.
- **Live events** — every `RunEvent` streams over SSE: model text, tool calls,
  approval decisions, tool results, done.
- **Pending approvals** — write-class tools pause here instead of the
  terminal. Approve or Deny; the run continues. The panel polls every 2 seconds.
- **Run transcript** — paste a run id to inspect the full recorded event log
  (the same JSONL saved under `~/.omni/agents/<id>/runs/`).
- **Docs** — browse an agent's docs workspace (`~/.omni/agents/<id>/docs/`),
  rendered as Markdown.
- **Artifacts** — list the agent's rich HTML artifacts
  (`~/.omni/agents/<id>/artifacts/`, saved with the `artifact.save` tool)
  and preview the selected one in a fully-sandboxed `<iframe sandbox="">`:
  **no scripts, no same-origin, no forms** — artifacts are static documents
  (inline CSS/SVG charts and reports), never apps. JavaScript is
  intentionally disabled in the viewer; this is a deliberate safety boundary,
  not a missing feature.

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | The console page |
| `GET` | `/api/agents` | `[{ id, name, description }]` |
| `POST` | `/api/chat` | `{ agentId, message }` → `{ runId }` (run starts in background) |
| `GET` | `/api/events?runId=` | SSE stream of the run's events |
| `GET` | `/api/approvals` | Pending approvals `[{ id, runId, tool, args, createdAt }]` |
| `POST` | `/api/approvals/:id` | `{ approved: boolean }` → resolves it, the run continues |
| `GET` | `/api/runs/:runId` | `{ runId, agentId, done, output, events }` |
| `GET` | `/api/docs?agentId=` | `{ files }` in the agent's docs workspace |
| `GET` | `/api/docs/content?agentId=&path=` | One document's Markdown content |
| `GET` | `/api/artifacts?agentId=` | `{ files }` in the agent's artifacts dir |
| `GET` | `/api/artifacts/content?agentId=&name=` | One artifact's HTML (`text/html`; path-jailed) |

## Security

**The console binds `127.0.0.1` only.** That is deliberate: it is a local
operator UI, like a database admin panel.

- **Optional token (new in v0.4):** set `OMNI_WEB_TOKEN` to a long random
  string and every request to `/` and `/api/*` must carry
  `?token=<value>` (compared in constant time). The page's own API calls
  append it automatically. **Set a token if you ever bind wider** than
  localhost, or if anyone other than you can reach the machine.
- Do NOT expose the port to the public internet (no `--host 0.0.0.0` option
  exists on purpose).
- Anyone who can reach the port can chat as your agents and approve their
  tool calls — treat localhost access as full access.
- If you need remote access, put it behind an authenticated reverse proxy
  (e.g. Tailscale Serve, Cloudflare Tunnel with Access) — never raw.

Denying an approval, or stopping the server, resolves pending approvals as
denied so runs never hang forever.
