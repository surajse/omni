# Omni Architecture (v0.1)

## The kernel loop

```
user task
   │
   ▼
┌─────────┐   complete()   ┌──────────┐
│  Agent  │ ──────────────▶│ Provider │ (OpenAI-compatible | mock)
│         │◀────────────── │          │  returns text + toolCalls
└─────────┘                └──────────┘
   │ for each tool call
   ▼
┌──────────────┐  allow?  ┌─────────────┐
│ PolicyEngine │ ────────▶│ ToolGateway │──▶ handler (builtin | MCP | plugin)
└──────────────┘  ask?    └─────────────┘
   │ deny?            ▲ ask → ApprovalHandler (console y/n)
   ▼                  │
tool message:         │ result / error → tool message
DENIED / SKIPPED      │
   │                  ▼
   └─────────▶ next model turn … until text-only reply or maxSteps
```

Key files in `packages/kernel/src`:

- `types.ts` — shared types: messages, tools, agent config, policy rules, run events.
- `providers.ts` — `ModelProvider` interface; OpenAI-compatible HTTP provider;
  scripted `MockProvider` for tests/demos.
- `tools.ts` — `ToolGateway`: register/list/execute named tools.
- `policy.ts` — `PolicyEngine`: first-match-wins rules with trailing-`*`
  wildcards; default is `allow` for read-only tools, `ask` otherwise.
- `agent.ts` — `Agent.run()`: builds messages (system prompt + optional
  memory summary + task), loops model ↔ tools, emits `RunEvent`s.
- `mcp.ts` — `McpToolSource`: wraps an MCP server over stdio, maps its tools
  into the gateway (read-only heuristic by name prefix).
- `registry.ts` — `AgentRegistry`: one JSON file per agent in a directory.

## Packages

| Package | Depends on | Role |
| --- | --- | --- |
| `@omni/kernel` | `@modelcontextprotocol/sdk` | Agent loop, tools, policy, MCP, registry |
| `@omni/memory` | (none, `node:sqlite`) | Namespaced key/value memory |
| `@omni/plugin-spec` | (none) | Plugin manifest schema + validator |
| `@omni/channels` | (none) | `Channel` interface + console channel |
| `omni` (apps/cli) | all four (workspace) | CLI wiring it together |

The kernel deliberately does **not** depend on `@omni/memory`; it accepts any
object with a `recall(namespace)` method (structural typing). The CLI wires
the real `SqliteMemoryStore` in.

## Data flow for a tool call

1. Provider returns `toolCalls`.
2. `Agent` emits `tool-call`, asks `PolicyEngine.decide(name, readOnly)`.
3. `deny` → approval event (`denied`), tool message `DENIED by policy`.
   `ask` → `ApprovalHandler` (CLI: console y/n); declined → approval event
   (`skipped`), tool message `SKIPPED (not approved)`.
4. `ToolGateway.execute` runs the handler; output or `ERROR: …` becomes a
   tool message; `tool-result` event is emitted either way.

## Where v0.1 ends

The kernel is a solid local agent runtime: real model calls, real tool
execution, real policy enforcement, real persistence. It is not yet
sandboxed computer use, not yet multi-user, and channels are console-only.
See `docs/ROADMAP.md`.
