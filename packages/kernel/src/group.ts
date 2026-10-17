// Group chat: a shared room where multiple agents (and the user) take turns.
// Turn order is round-robin by default; `@<agentId>` mentions route the next
// turn to that member. A turn ends early when an agent replies with `/done`.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Agent } from './agent.js';
import type { AgentConfig, RunEvent } from './types.js';
import type { HandoffMade } from './handoff.js';

export interface GroupSession {
  id: string;
  name: string;
  /** Agent ids in turn order. */
  members: string[];
  maxRounds: number;
  createdAt: string;
}

export interface GroupMessage {
  /** 'user' or an agent id. */
  role: string;
  content: string;
  at: string;
}

export interface GroupTurn {
  member: string;
  output: string;
}

function isGroupSession(v: unknown): v is GroupSession {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['name'] === 'string' &&
    Array.isArray(r['members']) &&
    r['members'].every((m: unknown) => typeof m === 'string') &&
    typeof r['maxRounds'] === 'number' &&
    typeof r['createdAt'] === 'string'
  );
}

function isGroupMessage(v: unknown): v is GroupMessage {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r['role'] === 'string' && typeof r['content'] === 'string' && typeof r['at'] === 'string';
}

/** Filesystem-backed group sessions: <home>/groups/<name>.json + .jsonl history. */
export class GroupStore {
  constructor(private readonly home: string) {}

  private dir(): string {
    const d = join(this.home, 'groups');
    mkdirSync(d, { recursive: true });
    return d;
  }

  private sessionPath(name: string): string {
    return join(this.dir(), `${name}.json`);
  }

  private historyPath(name: string): string {
    return join(this.dir(), `${name}.jsonl`);
  }

  create(name: string, members: string[], maxRounds = 6): GroupSession {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid group name "${name}"`);
    if (members.length < 2) throw new Error('a group needs at least 2 members');
    if (new Set(members).size !== members.length) throw new Error('group members must be unique');
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) {
      throw new Error('maxRounds must be an integer 1-50');
    }
    const session: GroupSession = {
      id: name,
      name,
      members: [...members],
      maxRounds,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(this.sessionPath(name), JSON.stringify(session, null, 2) + '\n', 'utf8');
    return session;
  }

  get(name: string): GroupSession {
    let raw: string;
    try {
      raw = readFileSync(this.sessionPath(name), 'utf8');
    } catch {
      throw new Error(`unknown group: ${name}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`corrupt group file: ${name}`);
    }
    if (!isGroupSession(parsed)) throw new Error(`corrupt group file: ${name}`);
    return parsed;
  }

  list(): GroupSession[] {
    let entries;
    try {
      entries = readdirSync(this.dir(), { withFileTypes: true });
    } catch {
      return [];
    }
    const out: GroupSession[] = [];
    for (const e of entries.filter((d) => d.isFile() && d.name.endsWith('.json'))) {
      try {
        out.push(this.get(e.name.slice(0, -'.json'.length)));
      } catch {
        // skip corrupt files
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  remove(name: string): void {
    const sessionPath = this.sessionPath(name);
    try {
      readFileSync(sessionPath, 'utf8');
    } catch {
      throw new Error(`unknown group: ${name}`);
    }
    rmSync(sessionPath, { force: true });
    rmSync(this.historyPath(name), { force: true });
  }

  appendHistory(name: string, msg: GroupMessage): void {
    this.get(name); // throws on unknown group
    appendFileSync(this.historyPath(name), JSON.stringify(msg) + '\n', 'utf8');
  }

  history(name: string): GroupMessage[] {
    this.get(name); // throws on unknown group
    let raw: string;
    try {
      raw = readFileSync(this.historyPath(name), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: GroupMessage[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isGroupMessage(parsed)) out.push(parsed);
      } catch {
        // skip corrupt lines
      }
    }
    return out;
  }

  clearHistory(name: string): void {
    this.get(name);
    writeFileSync(this.historyPath(name), '', 'utf8');
  }
}

export interface GroupTurnDeps {
  /** Load an agent config by id (throws on unknown). */
  getConfig: (id: string) => AgentConfig;
  /** Build the agent wiring (same shape as handoff sub-agents). */
  makeDeps: (config: AgentConfig) => HandoffMade | Promise<HandoffMade>;
  onEvent?: (event: RunEvent, member: string) => void;
}

/** Find `@<member>` mentions of group members in text (case-sensitive ids). */
export function findMentions(text: string, members: string[]): string[] {
  const found: string[] = [];
  for (const m of members) {
    if (new RegExp(`@${escapeRe(m)}\\b`).test(text) && !found.includes(m)) {
      found.push(m);
    }
  }
  return found;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function transcriptText(history: GroupMessage[]): string {
  return history.map((m) => `${m.role}: ${m.content}`).join('\n');
}

/**
 * Run one group turn: the user's message is broadcast, then members take
 * turns (mention-routed, else round-robin) until maxRounds or `/done`.
 */
export async function runGroupTurn(
  store: GroupStore,
  session: GroupSession,
  userMessage: string,
  deps: GroupTurnDeps,
  opts: { maxSteps?: number } = {},
): Promise<GroupTurn[]> {
  const { members } = session;
  store.appendHistory(session.name, { role: 'user', content: userMessage, at: new Date().toISOString() });

  const turns: GroupTurn[] = [];
  const mentioned = findMentions(userMessage, members);
  let nextIndex = mentioned.length > 0 ? members.indexOf(mentioned[0]!) : 0;
  let lastSpeaker: string | null = null;

  for (let round = 0; round < session.maxRounds; round++) {
    const member = members[nextIndex % members.length]!;
    const config = deps.getConfig(member);
    const made = await deps.makeDeps(config);
    const history = store.history(session.name);
    const task =
      `You are ${member}, a member of the group "${session.name}" ` +
      `(members: ${members.join(', ')}). ` +
      `Shared conversation so far:\n${transcriptText(history)}\n\n` +
      `Respond as ${member} with one message. Address teammates with @<id> when you want them next. ` +
      `If there is nothing left for the group to do, reply with /done.`;
    const agent = new Agent(made.config, {
      ...made.deps,
      onEvent: deps.onEvent ? (e) => deps.onEvent!(e, member) : made.deps.onEvent,
    });
    const output = await agent.run(task, { maxSteps: opts.maxSteps ?? 8 });
    turns.push({ member, output });
    store.appendHistory(session.name, { role: member, content: output, at: new Date().toISOString() });
    lastSpeaker = member;
    if (output.includes('/done')) break;

    // Mention routing: an @<member> in the reply picks the next speaker.
    const next = findMentions(output, members).find((m) => m !== lastSpeaker);
    nextIndex = next ? members.indexOf(next) : (members.indexOf(member) + 1) % members.length;
  }
  return turns;
}
