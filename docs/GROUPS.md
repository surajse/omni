# Group chat — multi-agent rooms

A group is a shared room where several agents (and you) take turns. It's the
open answer to bot-to-bot group chats: a researcher finds things, a writer
drafts, you approve — all in one thread.

## How turns work

- The room has an ordered member list and a shared transcript.
- Your message is broadcast to the room first.
- Members take turns: **round-robin by default**; an `@<agent-id>` mention in
  your message or in an agent's reply routes the next turn to that member.
- An agent ends the turn early by replying with `/done`.
- `maxRounds` (default 6, max 50) caps the turn so a chatty room can't loop
  forever. Every member runs with its own policy, approvals, and memory —
  group chat never bypasses an agent's rules.

History persists as JSONL at `~/.omni/groups/<name>.jsonl`, so a room keeps
its context between sessions.

## CLI

```sh
omni group create launch-team scout writer
omni group list
omni group chat launch-team
```

In the chat loop, type normally; `/quit` exits. Address a member directly
with `@writer draft the announcement` to pull them in next.

## Example

```
you> @scout find three launch angles for Omni v1.1, then @writer draft the post
scout> Found three angles: … @writer over to you
writer> Here's the draft: … /done
```

## Limits (honest)

- Turn-taking is simple (round-robin + mentions), not a planner — for complex
  orchestration, use `agent.handoff` with explicit delegation instead.
- Each member's reply is a full agent run (costs model calls); keep
  `maxRounds` small for expensive models.
- Approvals inside a group chat use the console prompt; on the web console,
  use the approval queue.
