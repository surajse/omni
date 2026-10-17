# Omni Plugin Registry

Share plugins, discover them, install them with one command. A **registry** is
just a directory (or a git repo) containing an `index.json` — no server, no
account, no lock-in.

```sh
omni plugin source add examples ./registries/examples
omni plugin search calcom
omni plugin install calcom
omni plugin list
```

## Index format

`index.json` at the registry root:

```json
{
  "version": 1,
  "plugins": [
    {
      "name": "calcom",
      "version": "1.0.0",
      "description": "Cal.com scheduling via MCP",
      "keywords": ["calendar", "scheduling"],
      "source": { "type": "path", "path": "./plugins/calcom" }
    },
    {
      "name": "echo",
      "version": "1.0.0",
      "source": { "type": "git", "url": "https://github.com/example/echo-plugin" }
    }
  ]
}
```

| Field | Required | Description |
| --- | --- | --- |
| `version` | yes | Index format version, currently `1` |
| `plugins` | yes | Array of plugin entries |
| `plugins[].name` | yes | Unique within the index |
| `plugins[].version` | yes | Semver string (informational) |
| `plugins[].description` | no | Shown in search results |
| `plugins[].keywords` | no | Searched, case-insensitively |
| `plugins[].source` | yes | `{ "type": "path", "path": "..." }` (relative to the index dir, or absolute) or `{ "type": "git", "url": "..." }` |

## Sources

```sh
omni plugin source add <name> <location>   # local dir or git URL
omni plugin source list
omni plugin source remove <name>
```

- A **local dir** source is used in place; the dir must contain `index.json`.
- A **git URL** source is cloned with `git clone --depth 1` into
  `~/.omni/registries/<name>`. Clear error if `git` is missing.
- Source names: `^[a-z0-9-]+$`.

## Install flow

```sh
omni plugin install <name>     # resolves across all sources, first match wins
omni plugin list               # installed plugins
omni plugin uninstall <name>
```

`install` materializes the plugin into `~/.omni/plugins/<name>`:

1. **Omni-native**: the plugin dir contains `omni.plugin.json` → validated with
   `@omni/plugin-spec`. Invalid manifests are rejected before anything is copied.
2. **Grok-format**: the plugin dir contains `.grok-plugin/` → the
   `@omni/importers` converter runs automatically and writes the converted
   `omni.plugin.json` plus any `skills/*/SKILL.md` files next to it.
3. Otherwise: error (`neither an Omni plugin nor a .grok-plugin`).

Git-sourced plugins are copied out of the already-cloned registry — no extra
network fetch at install time.

## Searching

```sh
omni plugin search <query>
```

Substring match over name, description, and keywords, case-insensitive, across
all sources.

## The bundled example registry

`registries/examples/` in this repo ships an `index.json` listing two plugins:

- **hello** — the Omni-native example (one builtin tool + one MCP-stdio tool).
- **echo** — a second tiny example with one builtin `echo` tool.

```sh
omni plugin source add examples ./registries/examples
omni plugin install echo
```

## Honest limits

- No signature verification or sandboxing of installed plugins — only install
  from sources you trust (same trust model as `npm install` from a git URL).
- Version resolution is "first match wins"; no semver ranges or dependency
  solving yet.
- Git sources are shallow-cloned once at `source add`; re-add the source to
  refresh.
