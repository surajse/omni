// TeamManager: share agents as packs through a plain directory.
//
// Layout:
//   <teamsRoot>/<team>/team.json                  {name, createdAt}
//   <teamsRoot>/<team>/agents/<agentId>.omnipack.json
//   <teamsRoot>/<team>/skills/                    (shared skill docs, informational)
//
// There is no server: point teamsRoot at a shared git repo, Dropbox/Nextcloud
// folder, or any synced directory and teams "just work". Packs are ordinary
// JSON files, so git history gives you versioning for free.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packAgent, unpackAgent, type AgentConfig, type AgentPack, type PackMemoryStore } from '@omni/kernel';

const NAME_RE = /^[a-z0-9-]+$/;
const PACK_SUFFIX = '.omnipack.json';

export interface TeamInfo {
  name: string;
  createdAt: string;
}

export class TeamManager {
  constructor(private readonly teamsRoot: string) {}

  private teamDir(team: string): string {
    return join(this.teamsRoot, team);
  }

  private assertTeam(team: string): string {
    if (!NAME_RE.test(team)) throw new Error(`invalid team name "${team}": must match ${NAME_RE.source}`);
    const dir = this.teamDir(team);
    if (!existsSync(join(dir, 'team.json'))) throw new Error(`unknown team: ${team}`);
    return dir;
  }

  /** Create a new team directory. */
  init(name: string): TeamInfo {
    if (!NAME_RE.test(name)) throw new Error(`invalid team name "${name}": must match ${NAME_RE.source}`);
    const dir = this.teamDir(name);
    if (existsSync(join(dir, 'team.json'))) throw new Error(`team already exists: ${name}`);
    mkdirSync(join(dir, 'agents'), { recursive: true });
    mkdirSync(join(dir, 'skills'), { recursive: true });
    const info: TeamInfo = { name, createdAt: new Date().toISOString() };
    writeFileSync(join(dir, 'team.json'), JSON.stringify(info, null, 2) + '\n', 'utf8');
    return info;
  }

  list(): string[] {
    let entries: string[];
    try {
      entries = readdirSync(this.teamsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
    return entries.filter((n) => existsSync(join(this.teamsRoot, n, 'team.json'))).sort();
  }

  private packPath(team: string, agentId: string): string {
    return join(this.assertTeam(team), 'agents', `${agentId}${PACK_SUFFIX}`);
  }

  /** Publish an agent from `home` (~/.omni) into the team as a pack. */
  publish(home: string, agentId: string, team: string, memory: PackMemoryStore): AgentPack {
    const dir = this.assertTeam(team);
    const pack = packAgent(home, agentId, memory); // throws "Unknown agent" when missing
    writeFileSync(join(dir, 'agents', `${pack.agent.id}${PACK_SUFFIX}`), JSON.stringify(pack, null, 2) + '\n', 'utf8');
    return pack;
  }

  listAgents(team: string): string[] {
    const dir = this.assertTeam(team);
    return readdirSync(join(dir, 'agents'))
      .filter((f) => f.endsWith(PACK_SUFFIX))
      .map((f) => f.slice(0, -PACK_SUFFIX.length))
      .sort();
  }

  /** Install a team's agent pack into `home`, optionally under a new id. */
  install(home: string, team: string, agentId: string, memory: PackMemoryStore, asId?: string): AgentConfig {
    const path = this.packPath(team, agentId);
    if (!existsSync(path)) throw new Error(`team "${team}" has no agent "${agentId}"`);
    const pack: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return unpackAgent(home, pack, memory, asId);
  }

  removeAgent(team: string, agentId: string): void {
    const path = this.packPath(team, agentId);
    if (!existsSync(path)) throw new Error(`team "${team}" has no agent "${agentId}"`);
    rmSync(path);
  }
}
