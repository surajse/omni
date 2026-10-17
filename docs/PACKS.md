# Specialist packs — one-command expert agents

Packs are Omni's answer to "specialist" agents: a ready-made role identity —
system prompt, tools, policy, skills, and routines — installable with one
command. No prompt engineering required.

## The four flagship packs

| Pack | What it does | Needs from you |
|------|--------------|----------------|
| `researcher` | Deep research briefs with inline sources, saved to docs | A web search/fetch MCP tool |
| `inbox-triage` | Scans mail, drafts replies in your voice, **never sends** without approval; weekday 8am routine included | An email MCP tool |
| `repo-watcher` | Tracks a git repo's commits and writes risk-assessed change notes; daily 9am routine included | Docker (sandbox) or a git MCP tool |
| `meeting-prep` | One-page briefings (objective, attendees, talking points) before meetings; weekday 8:30am routine included | A calendar MCP tool |

## CLI

```sh
omni pack list
omni pack install researcher            # installs as agent "researcher"
omni pack install researcher --as scout # custom agent id
```

Install prints a **setup checklist** — the human-readable `requires` list
(e.g. which MCP tool to attach). Packs are honest about what they can't do
alone.

Set `OMNI_PACKS_DIR` to use your own packs folder; the repo's `packs/`
directory is the default.

## Pack format (`pack.json`)

```json
{
  "name": "researcher",
  "version": "1.0.0",
  "description": "…",
  "requires": ["a web search/fetch MCP tool"],
  "agent": {
    "name": "Researcher",
    "systemPrompt": "…",
    "tools": ["doc.write", "memory_recall"],
    "policy": []
  },
  "skills": [
    { "name": "research-brief", "description": "…", "steps": ["…"], "requiredTools": ["doc.write"] }
  ],
  "routines": [{ "cron": "0 8 * * 1-5", "task": "…" }]
}
```

`validatePack()` rejects malformed packs with specific errors; see
`packages/packs/src/types.ts` for the full schema.

## Writing your own

Copy `packs/researcher/`, edit `pack.json`, run
`omni pack install <your-pack> --as test` in a scratch home. Keep system
prompts tight: role, method (numbered), hard rules. Ship the pack's folder to
share it — it's just JSON.
