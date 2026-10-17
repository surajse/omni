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

## Security

**The console binds `127.0.0.1` only and has no authentication.** That is
deliberate for v0.3: it is a local operator UI, like a database admin panel.

- Do NOT expose the port to the public internet (no `--host 0.0.0.0` option
  exists on purpose).
- Anyone who can reach the port can chat as your agents and approve their
  tool calls — treat localhost access as full access.
- If you need remote access, put it behind an authenticated reverse proxy
  (e.g. Tailscale Serve, Cloudflare Tunnel with Access) — never raw.

Denying an approval, or stopping the server, resolves pending approvals as
denied so runs never hang forever.
