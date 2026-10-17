# The Killer Demo: what Grok Bot can't do

**Thesis:** xAI's Grok Bot can *run* a plugin template. Omni can *import* that
same template — then give the agent superpowers Grok Bot will never have:
proactive watchers, a document workspace, and multi-agent group chat, all
portable across models and machines.

This walkthrough is 100% real: every command below works against this repo's
CLI. It uses the genuine `calcom` plugin from xAI's public
[`plugin-marketplace`](https://github.com/xai-org/plugin-marketplace) —
the same `.grok-plugin` format Grok Bot consumes.

## Act 1 — Steal the template (2 minutes)

```sh
# 1. Grab one real Grok plugin (shallow clone, ~seconds)
git clone --depth 1 https://github.com/xai-org/plugin-marketplace /tmp/grok-market

# 2. Point an Omni registry at it (a registry is just a folder with index.json)
mkdir -p /tmp/grok-registry
cat > /tmp/grok-registry/index.json << 'EOF'
{
  "version": 1,
  "plugins": [
    {
      "name": "calcom",
      "version": "1.0.0",
      "description": "Cal.com scheduling via hosted MCP (imported from xAI's marketplace)",
      "source": { "type": "path", "path": "/tmp/grok-market/external_plugins/calcom" }
    }
  ]
}
EOF

# 3. Install it — Omni auto-converts .grok-plugin → .omni-plugin
omni plugin source add grok-market /tmp/grok-registry
omni plugin install calcom
# → Installed calcom@1.0.0 → ~/.omni/plugins/calcom
# → Note: converted from .grok-plugin format (manifest + skills written).

# 4. Inspect what you got: a validated omni.plugin.json with an
#    mcp-http discover tool, plus the original SKILL.md, sitting in
#    ~/.omni/plugins/calcom — yours now, no xAI account needed.
omni plugin list
```

**What just happened:** a competitor's ecosystem became your onboarding
funnel. Grok Bot users need a SuperGrok/Cursor subscription to touch this
template. You needed `git`.

## Act 2 — Give the agent senses Grok Bot doesn't have (3 minutes)

```sh
# 5. A specialist agent, one command
omni pack install researcher --as scout

# 6. A watcher: ping me when Cal.com's MCP docs change (Dots-style proactive
#    research, but the rule is yours and the data never leaves your machine)
omni watch add scout url:https://cal.com/docs/mcp-server \
  --every "0 */6 * * *" \
  --task "Summarize what changed on this page. If it's a breaking change, write docs/mcp-changes.md and tell me."
omni watch check <watch-id>   # one-shot check right now

# 7. A document workspace the agent writes to (OpenDots-Spaces-style)
omni run scout "Research the calcom plugin's MCP tools and write a one-page brief to docs/calcom-brief.md"
# → web console → Docs tab shows the brief. Grok Bot has no agent-owned docs.
```

## Act 3 — Teamwork Grok Bot charges extra for (2 minutes)

```sh
# 8. A second specialist, then a group room
omni pack install meeting-prep --as prep
omni group create launch-team scout prep

# 9. Talk to the team: scout researches, prep turns it into a briefing
omni group chat launch-team
# > @scout what did the calcom MCP change this week?
# scout: … prep: … (labeled turns, shared history, /done to finish)
```

## The punchline

| | Grok Bot | Omni (this demo) |
|---|---|---|
| Run the calcom template | ✅ ($8–200/mo, xAI account) | ✅ (free, imported) |
| Watch the vendor's docs proactively | ❌ | ✅ watchers |
| Agent-owned research documents | ❌ | ✅ docs/ |
| Multi-agent briefing room | 🟡 (group chats, same cloud) | ✅ group chat, your machine |
| Move the whole setup to another model | ❌ | ✅ agent pack export |
| Cost | subscription meter | $0 + your model key |

**One agent, every model, every channel, your machine — and now, better
than all.**
