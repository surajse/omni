// Specialist pack format: a ready-made role agent — config + skills +
// routines — installable with one command.
import type { PolicyRule } from '@omni/kernel';

export interface PackAgentDef {
  name: string;
  systemPrompt: string;
  tools: string[];
  policy: PolicyRule[];
}

export interface PackSkillDef {
  name: string;
  description: string;
  steps: string[];
  requiredTools: string[];
}

export interface PackRoutineDef {
  cron: string;
  task: string;
}

export interface SpecialistPack {
  name: string;
  version: string;
  description: string;
  /** Human-readable setup checklist, e.g. "an email MCP tool". */
  requires: string[];
  agent: PackAgentDef;
  skills: PackSkillDef[];
  routines: PackRoutineDef[];
}

export type ValidatePackResult =
  | { ok: true; pack: SpecialistPack }
  | { ok: false; errors: string[] };

const NAME_RE = /^[a-z0-9-]+$/;

function err(errors: string[], msg: string): void {
  errors.push(msg);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isStr);
}

/** Validate a parsed pack.json; returns typed pack or a list of errors. */
export function validatePack(json: unknown): ValidatePackResult {
  const errors: string[] = [];
  if (typeof json !== 'object' || json === null) {
    return { ok: false, errors: ['pack must be a JSON object'] };
  }
  const p = json as Record<string, unknown>;

  if (!isStr(p['name']) || !NAME_RE.test(p['name'])) {
    err(errors, 'pack.name must match ^[a-z0-9-]+$');
  }
  if (!isStr(p['version']) || !/^\d+\.\d+\.\d+$/.test(p['version'])) {
    err(errors, 'pack.version must be semver x.y.z');
  }
  if (!isStr(p['description']) || !p['description'].trim()) {
    err(errors, 'pack.description must be a non-empty string');
  }
  if (!isStrArray(p['requires'])) {
    err(errors, 'pack.requires must be an array of strings');
  }

  const agent = p['agent'] as Record<string, unknown> | undefined;
  if (typeof agent !== 'object' || agent === null) {
    err(errors, 'pack.agent must be an object');
  } else {
    if (!isStr(agent['name']) || !agent['name'].trim()) err(errors, 'pack.agent.name must be non-empty');
    if (!isStr(agent['systemPrompt']) || !agent['systemPrompt'].trim()) {
      err(errors, 'pack.agent.systemPrompt must be non-empty');
    }
    if (!isStrArray(agent['tools'])) err(errors, 'pack.agent.tools must be an array of strings');
    if (!Array.isArray(agent['policy'])) err(errors, 'pack.agent.policy must be an array');
  }

  if (!Array.isArray(p['skills'])) {
    err(errors, 'pack.skills must be an array');
  } else {
    for (const [i, s] of (p['skills'] as unknown[]).entries()) {
      const sk = s as Record<string, unknown>;
      if (typeof sk !== 'object' || sk === null) {
        err(errors, `pack.skills[${i}] must be an object`);
        continue;
      }
      if (!isStr(sk['name']) || !NAME_RE.test(sk['name'])) {
        err(errors, `pack.skills[${i}].name must match ^[a-z0-9-]+$`);
      }
      if (!isStr(sk['description']) || !sk['description'].trim()) {
        err(errors, `pack.skills[${i}].description must be non-empty`);
      }
      if (!isStrArray(sk['steps']) || sk['steps'].length === 0) {
        err(errors, `pack.skills[${i}].steps must be a non-empty array of strings`);
      }
      if (!isStrArray(sk['requiredTools'])) {
        err(errors, `pack.skills[${i}].requiredTools must be an array of strings`);
      }
    }
  }

  if (!Array.isArray(p['routines'])) {
    err(errors, 'pack.routines must be an array');
  } else {
    for (const [i, r] of (p['routines'] as unknown[]).entries()) {
      const rt = r as Record<string, unknown>;
      if (typeof rt !== 'object' || rt === null || !isStr(rt['cron']) || !isStr(rt['task'])) {
        err(errors, `pack.routines[${i}] must be { cron: string, task: string }`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, pack: json as SpecialistPack };
}
