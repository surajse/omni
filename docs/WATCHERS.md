# Watchers — proactive observation

Watchers are Omni's answer to "proactive research": instead of waiting for you
to ask, an agent watches a target (a URL, a file, or a command's output) and
acts only when something **changes**.

## How it works

1. You attach a watch to an agent: target + cron schedule + task + cooldown.
2. Every tick, the watch daemon fetches the target, hashes the normalized
   content, and compares it to the stored snapshot.
3. The **first fetch only stores the baseline** — no false-positive "change".
4. On a real change (and once the cooldown since the last notification has
   elapsed), the agent runs your task with the change excerpt appended.

Snapshots live per agent: `<agentHome>/watches.json` and
`<agentHome>/watch-snapshots.json`. Nothing leaves your machine.

## CLI

```sh
# Watch a price page every 15 minutes; ping me on Telegram when it changes
omni watch add scout "url:https://example.com/product" \
  --every "*/15 * * * *" \
  --task "The product page changed. Summarize what changed and tell me if the price moved." \
  --cooldown 120

# Watch a file, or a command's output
omni watch add scout "file:/var/log/app.log" --every "*/5 * * * *" --task "Summarize new log lines."
omni watch add ops "cmd:df -h / | tail -1" --every "0 * * * *" --task "Alert me if disk usage is over 85%."

omni watch list            # all watches
omni watch list scout      # this agent's watches
omni watch check <watch-id>  # one-shot check now (prints CHANGED/unchanged + excerpt)
omni watch remove <watch-id>
omni watch run             # start the daemon (Ctrl+C to stop)
```

Target specs: `url:<…>`, `file:<path>`, `cmd:<shell command>`.

## Daemon behavior

- Ticks every 60s (`--tick-ms` overrides); a watch fires at most once per cron minute.
- On change, the agent runs with approvals **auto-skipped** (logged), same as
  the routine daemon. Prefer read-only watch tasks; route anything
  consequential through a channel where you can approve it.
- Fetch failures are logged and retried next tick — one bad target never kills
  the daemon.

## Limits (honest)

- Change detection is hash-based: it notices *that* something changed, not
  *whether it matters*. Your task prompt decides what counts as meaningful.
- URL fetching is plain HTTP(S) text — no JS rendering. Pages that need a
  browser won't work (that's what the sandbox computer is for).
- Cooldown is per watch, default 60 minutes — tune it so a flapping page
  doesn't spam you.
