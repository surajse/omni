// PackManager: list and install specialist packs.
// A pack installs an agent (registry) + its skills (SkillManager) +
// its routines (RoutineStore) in one command.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRegistry } from '@omni/kernel';
import type { AgentConfig } from '@omni/kernel';
import { SkillManager } from '@omni/skills';
import { RoutineStore } from '@omni/scheduler';
import { validatePack, type SpecialistPack } from './types.js';

export interface PackSummary {
  name: string;
  version: string;
  description: string;
}

export interface InstallResult {
  agentId: string;
  skills: number;
  routines: number;
  /** Human-readable setup checklist from the pack. */
  requires: string[];
}

/**
 * Resolve the directory holding installable packs.
 * Order: explicit override → OMNI_PACKS_DIR → the repo's packs/ directory
 * (resolved relative to this module, works from src/ and dist/).
 */
export function resolvePacksDir(override?: string): string {
  if (override) return override;
  const env = process.env['OMNI_PACKS_DIR'];
  if (env) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, '..', '..', '..', '..', 'packs');
  if (existsSync(join(candidate, 'researcher', 'pack.json'))) return candidate;
  throw new Error('packs directory not found (set OMNI_PACKS_DIR to a packs folder)');
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'agent'
  );
}

export function readPackFile(dir: string): SpecialistPack {
  const path = join(dir, 'pack.json');
  if (!existsSync(path)) {
    throw new Error(`not a pack directory (no pack.json): ${dir}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`invalid JSON in ${path}`);
  }
  const result = validatePack(json);
  if (!result.ok) {
    throw new Error(`invalid pack ${path}:\n  - ${result.errors.join('\n  - ')}`);
  }
  return result.pack;
}

export class PackManager {
  /** List installable packs found in packsDir (each subdir with pack.json). */
  listPacks(packsDir: string): PackSummary[] {
    let entries;
    try {
      entries = readdirSync(packsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: PackSummary[] = [];
    for (const e of entries.filter((d) => d.isDirectory())) {
      try {
        const pack = readPackFile(join(packsDir, e.name));
        out.push({ name: pack.name, version: pack.version, description: pack.description });
      } catch {
        // Skip directories that are not valid packs.
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  getPack(packsDir: string, name: string): SpecialistPack {
    const pack = readPackFile(join(packsDir, name));
    if (pack.name !== name) {
      throw new Error(`pack directory "${name}" contains pack "${pack.name}"`);
    }
    return pack;
  }

  /**
   * Install a pack into an Omni home: creates the agent, writes its skills,
   * adds its routines. Returns what was installed plus the setup checklist.
   */
  installPack(home: string, packsDir: string, name: string, asId?: string): InstallResult {
    const pack = this.getPack(packsDir, name);
    const agentsDir = join(home, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const registry = new AgentRegistry(agentsDir);

    const id = asId ?? slugify(pack.agent.name);
    const config: AgentConfig = {
      id,
      name: pack.agent.name,
      description: pack.description,
      model: {
        provider: 'mock',
        baseUrl: process.env['OMNI_BASE_URL'],
        apiKeyEnv: 'OMNI_API_KEY',
        model: process.env['OMNI_MODEL'] ?? 'mock',
      },
      systemPrompt: pack.agent.systemPrompt,
      tools: pack.agent.tools,
      policy: pack.agent.policy,
      memoryNamespace: id,
    };
    registry.create(config);

    const agentDir = join(agentsDir, id);
    const skills = new SkillManager(join(agentDir, 'skills'));
    for (const s of pack.skills) {
      skills.save({
        name: s.name,
        description: s.description,
        version: '1.0.0',
        steps: s.steps,
        requiredTools: s.requiredTools,
        createdFrom: `pack ${pack.name}@${pack.version}`,
        createdAt: new Date().toISOString(),
      });
    }

    const routines = new RoutineStore(agentDir);
    for (const r of pack.routines) {
      routines.add({ agentId: id, cron: r.cron, task: r.task });
    }

    return { agentId: id, skills: pack.skills.length, routines: pack.routines.length, requires: pack.requires };
  }
}
