# Omni Teams

Share whole agents — config, skills, routines, memory — through a plain
directory. Point the teams root at a shared git repo or a synced folder and
`publish` / `install` does the rest.

```sh
omni team init research-crew
omni team publish scout --team research-crew
# ...teammate, on their machine, same teams root...
omni team install research-crew scout --as scout-2
omni team list
omni team agents research-crew
```

## Layout

```
<teamsRoot>/<team>/
  team.json                  # { "name": "...", "createdAt": "..." }
  agents/<agentId>.omnipack.json
  skills/                    # shared skill files (reserved for future use)
```

The teams root defaults to `~/.omni/teams`. Override it per-command with
`OMNI_TEAMS_ROOT`:

```sh
OMNI_TEAMS_ROOT=~/shared/omni-teams omni team publish scout --team research-crew
```

For real sharing, make `~/shared/omni-teams` a git checkout (or Dropbox /
Syncthing / NFS folder) that everyone on the team syncs.

## Agent packs

`publish` calls `packAgent()` (`@omni/kernel`): one JSON document
(`*.omnipack.json`, `version: 1`) containing the agent config, its skills
(name + files), its routines, and its memory export. `install` calls
`unpackAgent()`, optionally renaming with `--as`.

```sh
omni agent export scout --out scout.omnipack.json
omni agent import scout.omnipack.json --as scout-2
```

**Memory hygiene:** secrets are scrubbed at export time. `exportJson` redacts
the *value* of any entry whose key looks like a credential name (`api_key`,
`token`, `passwd`, … — see `isSecretKey` in `@omni/kernel`), and
`scrubSecrets` redacts credential-looking assignments in free text. Assume a
published pack is public — don't publish an agent whose memory you wouldn't
paste into a chat.

## Honest limits

- **Filesystem sharing, not a service.** There is no access control, no merge
  conflict resolution, and no presence — last writer wins. A git repo behind
  the teams root gives you history and conflict markers for free; use it.
- **No live sync.** Publishing is a snapshot. Re-publish to share updates;
  teammates re-install to pick them up.
- **Memory is a snapshot too.** Routines and skills travel with the pack, but
  anything the agent learned after publishing stays local until the next
  publish.
- **Secrets are scrubbed, not encrypted.** Treat packs as public documents.
