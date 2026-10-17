# Omni Skills

Skills are reusable procedures an agent learns from its own run transcripts.
Demonstrate a workflow once (`omni run`), distill it into a skill
(`omni learn`), and the agent follows it on future tasks.

## The flow

```sh
# 1. Do the work once — the run transcript is saved automatically
omni run scout "list unread gmail and archive the newsletters"

# 2. Distill the last run into a named skill
omni learn scout triage-inbox "Triage the inbox: list unread, archive newsletters"

# 3. From now on, the skill is injected into scout's system prompt
omni run scout "triage my inbox"
```

## Skill format

A skill lives at `~/.omni/agents/<id>/skills/<name>/`:

- `skill.json` — machine-readable: `{ name, description, version, steps[],
  requiredTools[], createdFrom?, createdAt }`
- `SKILL.md` — human-readable rendering of the same (git-friendly)

Names must match `^[a-z0-9-]+$`.

## How learning works

`learnSkillFromTranscript` (in `@omni/skills`) is deterministic — the same
call sequence always produces the same skill:

1. Each tool call becomes a step: `Call gmail.list with {"q":"is:unread"}`.
2. Runs of **3+ consecutive identical tool names** collapse into one step:
   `Repeat 4×: Call gmail.archive with {"id":"a1"}`.
3. `requiredTools` lists unique tool names in order of first use.

Long arguments are truncated in the step text; the full arguments stay in the
saved run transcript (`~/.omni/agents/<id>/runs/<runId>.jsonl`).

## Prompt injection

Whenever an agent starts (`run`, `chat`, `routine run`, web console), its
saved skills are appended to the system prompt:

```
## Available skills

- **triage-inbox**: Triage the inbox: list unread, archive newsletters
  Steps: Call gmail.list with … → Call gmail.archive with …
  Tools: `gmail.list`, `gmail.archive`

When a task matches a skill, follow its steps in order.
```

Unknown skill names passed to `promptFragment()` are ignored, never an error.

## Managing skills

There is no CLI list/remove yet — skills are plain folders; delete
`~/.omni/agents/<id>/skills/<name>/` to remove one, or edit `SKILL.md` and
`skill.json` by hand. (Programmatic API: `SkillManager` in `@omni/skills`.)

## Limits (honest)

- Learning is **heuristic, not intelligent**: it compresses what the agent
  *did*, including mistakes. Review the generated `SKILL.md` before relying
  on it.
- Skills are text procedures, not fine-tuning: a weak model may still drift
  from the steps.
- Branching/conditional workflows are flattened into a linear step list.
