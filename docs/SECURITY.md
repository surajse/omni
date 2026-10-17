# Omni Security Model (v0.1)

## Approval model

Every tool call passes through the `PolicyEngine` before execution:

- Rules are evaluated **first match wins**. `match` is exact, or a trailing
  `*`/`**` prefix wildcard (e.g. `fs_*`).
- Effects: `allow` (run silently), `ask` (prompt first), `deny` (refuse).
- With no matching rule, the default is **`allow` for read-only tools and
  `ask` for everything else**. Denials and skips are written back into the
  model transcript (`DENIED by policy` / `SKIPPED (not approved)`), so the
  model cannot pretend a refused call succeeded.

The CLI's approval handler asks on the console (`[y/N]`); anything other
than an explicit `y` is a refusal. Approval decisions are emitted as
`RunEvent`s, so hosts can log or audit them.

## Secrets

- API keys live in **environment variables** (`OMNI_API_KEY`,
  `OMNI_BASE_URL`, `OMNI_MODEL`), never in code, configs, or the agent
  registry. `.env.example` contains only placeholder keys.
- `OpenAICompatibleProvider` sends the key solely as an `Authorization:
  Bearer` header and **never logs it** — not on success, not on error paths.
- CI runs a gitleaks job to catch accidental secret commits.
- Memory values are stored in a local SQLite file (`~/.omni/memory.db`);
  do not put secrets there — memory content is sent to the model.

## Execution boundaries (v0.1)

- Tool handlers run in-process with the user's privileges. There is **no
  sandbox** in v0.1 — only install plugins and MCP servers you trust, and
  prefer `deny` rules for tool families you never want an agent to touch.
- MCP servers are spawned over stdio as child processes of the CLI; an
  `mcp-stdio` plugin can execute arbitrary local code by design.
- The kernel never exfiltrates data on its own: the only network calls are
  the ones your provider makes (the chat-completions endpoint you
  configured) and the ones your tools/MCP servers make.

## Reporting issues

Open a GitHub issue with the `security` label for non-sensitive bugs. For
anything involving credentials or active exploitation, contact the
maintainer privately instead of filing publicly.
