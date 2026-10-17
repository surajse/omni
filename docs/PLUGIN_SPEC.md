# Omni Plugin Spec (manifest v1.0)

A plugin is a JSON manifest (`.omni-plugin.json`) declaring the tools it
contributes, where those tools come from, and which channels it targets.
The manifest is validated by `validateManifest()` in `@omni/plugin-spec`
(also via `omni plugin validate <file>`).

## Example

See `packages/plugin-spec/plugins/examples/hello.omni-plugin.json` — one
read-only builtin tool plus one MCP-stdio tool.

## Fields

| Field | Required | Description |
| --- | --- | --- |
| `manifestVersion` | yes | Must be `"1.0"` |
| `name` | yes | `^[a-z0-9-]{3,64}$` — lowercase, dashes |
| `version` | yes | Semver, e.g. `"1.2.3"` |
| `description` | no | Human-readable summary |
| `author` | no | Author name/handle |
| `tools` | yes | Non-empty array of tool declarations |
| `channels` | no | Channel ids this plugin targets, e.g. `["console"]` |
| `permissions` | no | Free-form permission labels (advisory in v0.1) |

### Tool declaration

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Unique within the manifest, non-empty |
| `description` | yes | Non-empty |
| `parameters` | yes | JSON Schema object for arguments |
| `readOnly` | no | Boolean; feeds the policy default (allow vs ask) |
| `source` | yes | One of the source kinds below |

### Source kinds

- **`mcp-stdio`**: `{ kind, command, args?, env? }` — spawn a command and
  speak MCP over stdio. `command` is required and non-empty.
- **`http`**: `{ kind, baseUrl }` — a remote tool endpoint. `baseUrl`
  is required and non-empty.
- **`builtin`**: `{ kind, ref }` — a tool implemented by the host (the CLI
  resolves `ref` to a registered gateway tool). `ref` is required.

## Validation rules (summary)

- Manifest must be a JSON object; `manifestVersion` must be `"1.0"`.
- `name`/`version` formats as above; tool names unique and non-empty.
- `parameters` must be an object; `readOnly` a boolean when present.
- Unknown `source.kind` values are rejected with a clear error.
- `channels`/`permissions`, when present, must be string arrays.

## Trust notes

A manifest is a **declaration**, not a proof. In v0.1 the host decides which
sources it will actually load (the CLI only auto-wires builtins); loading an
`mcp-stdio` plugin still spawns a local process with your user's privileges.
Treat third-party plugins like third-party code. See `docs/SECURITY.md`.
