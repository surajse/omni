// Agent packs: portable export/import of a whole agent — config, skills,
// routines, and memory — as one JSON document ("*.omnipack.json").
//
// PackMemoryStore is structural on purpose: the real SqliteMemoryStore
// satisfies it, and tests can stub it, without kernel depending on @omni/memory.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, normalize, relative, sep } from 'node:path';
import { AgentRegistry } from './registry.js';
import { isSecretKey, scrubSecrets } from './secrets.js';
import type { AgentConfig } from './types.js';

export interface PackSkill {
  name: string;
  /** Relative file path inside the skill dir -> file content. */
  files: Record<string, string>;
}

export interface PackRoutine {
  id: string;
  agentId: string;
  cron: string;
  task: string;
  enabled: boolean;
  createdAt: string;
}

export interface AgentPack {
  version: 1;
  exportedAt: string;
  agent: AgentConfig;
  skills: PackSkill[];
  routines: PackRoutine[];
  /** Memory entries for the agent's namespace, scrubbed of secrets. */
  memoryJson: string;
}

export interface PackMemoryStore {
  exportJson(namespace?: string): string;
  importJson(json: string): void;
}

const ID_RE = /^[a-z0-9-]+$/;

function isPackRoutine(v: unknown): v is PackRoutine {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['agentId'] === 'string' &&
    typeof r['cron'] === 'string' &&
    typeof r['task'] === 'string' &&
    typeof r['enabled'] === 'boolean' &&
    typeof r['createdAt'] === 'string'
  );
}

function readSkillFiles(skillsDir: string, name: string): Record<string, string> {
  const files: Record<string, string> = {};
  const root = join(skillsDir, name);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files[relative(root, full).split(sep).join('/')] = readFileSync(full, 'utf8');
      }
    }
  };
  walk(root);
  return files;
}

/** Reject absolute paths and `..` escapes before writing pack files to disk. */
function safeJoin(root: string, rel: string): string {
  const normalized = normalize(rel).split(sep).join('/');
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`unsafe path in pack: ${rel}`);
  }
  return join(root, normalized);
}

/** Export an agent (config + skills + routines + scrubbed memory) as a pack. */
/**
 * Redact the `value` of memory entries whose `key` looks like a credential
 * name. Memory exports store secrets as {"key":"api_key","value":"..."}, which
 * text-level scrubbing cannot see — the key name, not the JSON key, is the signal.
 * Non-array JSON passes through unchanged.
 */
function scrubMemoryValues(memoryJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(memoryJson);
  } catch {
    return memoryJson;
  }
  if (!Array.isArray(parsed)) return memoryJson;
  const redacted = parsed.map((e) => {
    if (typeof e === 'object' && e !== null && isSecretKey(String((e as Record<string, unknown>)['key'] ?? ''))) {
      return { ...(e as Record<string, unknown>), value: '[REDACTED]' };
    }
    return e;
  });
  return JSON.stringify(redacted);
}

export function packAgent(home: string, agentId: string, memory: PackMemoryStore): AgentPack {
  const registry = new AgentRegistry(join(home, 'agents'));
  const config = registry.get(agentId); // throws "Unknown agent" when missing
  const agentDir = join(home, 'agents', agentId);

  const skills: PackSkill[] = [];
  const skillsDir = join(agentDir, 'skills');
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()) {
      skills.push({ name: entry, files: readSkillFiles(skillsDir, entry) });
    }
  }

  let routines: PackRoutine[] = [];
  const routinesPath = join(agentDir, 'routines.json');
  if (existsSync(routinesPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(routinesPath, 'utf8'));
      if (Array.isArray(parsed)) routines = parsed.filter(isPackRoutine);
    } catch {
      // A corrupt routines file exports as "no routines" rather than failing the pack.
    }
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    agent: config,
    skills,
    routines,
    memoryJson: scrubSecrets(scrubMemoryValues(memory.exportJson(config.memoryNamespace))),
  };
}

function assertValidPack(pack: unknown): asserts pack is AgentPack {
  if (typeof pack !== 'object' || pack === null) throw new Error('invalid pack: not an object');
  const p = pack as Record<string, unknown>;
  if (p['version'] !== 1) throw new Error(`invalid pack: unsupported version ${JSON.stringify(p['version'])}`);
  const agent = p['agent'] as Record<string, unknown> | undefined;
  if (!agent || typeof agent['id'] !== 'string') throw new Error('invalid pack: agent.id is missing');
}

/**
 * Import a pack into `home`, optionally under a new agent id. Restores config,
 * skills, routines (re-pointed at the new id), and memory (namespace rewritten
 * when the id changes). Throws when the target id already exists.
 */
export function unpackAgent(home: string, pack: unknown, memory: PackMemoryStore, asId?: string): AgentConfig {
  assertValidPack(pack);
  const targetId = asId ?? pack.agent.id;
  if (!ID_RE.test(targetId)) {
    throw new Error(`invalid agent id "${targetId}": must match ${ID_RE.source}`);
  }
  const newNamespace = asId ? targetId : pack.agent.memoryNamespace;
  const config: AgentConfig = { ...pack.agent, id: targetId, memoryNamespace: newNamespace };

  const registry = new AgentRegistry(join(home, 'agents'));
  registry.create(config); // throws when the id already exists

  const agentDir = join(home, 'agents', targetId);
  mkdirSync(agentDir, { recursive: true });

  for (const skill of pack.skills) {
    if (typeof skill.name !== 'string' || !ID_RE.test(skill.name)) {
      throw new Error(`invalid pack: bad skill name ${JSON.stringify(skill.name)}`);
    }
    const files = skill.files && typeof skill.files === 'object' ? skill.files : {};
    for (const [rel, content] of Object.entries(files)) {
      if (typeof content !== 'string') throw new Error(`invalid pack: non-string file ${skill.name}/${rel}`);
      const dest = safeJoin(join(agentDir, 'skills', skill.name), rel);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, content, 'utf8');
    }
  }

  const routines = pack.routines.filter(isPackRoutine).map((r) => ({ ...r, agentId: targetId }));
  writeFileSync(join(agentDir, 'routines.json'), JSON.stringify(routines, null, 2) + '\n', 'utf8');

  // Rewrite memory namespaces when the agent id changed so the new agent
  // actually sees its imported memories.
  let memoryJson = pack.memoryJson;
  if (asId) {
    const entries: unknown = JSON.parse(memoryJson);
    if (Array.isArray(entries)) {
      for (const e of entries) {
        if (typeof e === 'object' && e !== null) {
          (e as Record<string, unknown>)['namespace'] = newNamespace;
        }
      }
      memoryJson = JSON.stringify(entries);
    }
  }
  memory.importJson(memoryJson);

  return config;
}

/** Remove every trace unpackAgent created (used by tests for cleanup). */
export function removeUnpackedAgent(home: string, agentId: string): void {
  new AgentRegistry(join(home, 'agents')).remove(agentId);
  const dir = join(home, 'agents', agentId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
