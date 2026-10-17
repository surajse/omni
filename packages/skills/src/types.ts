// Skill types: a skill is a named, reusable procedure learned from a run transcript.

export const SKILL_NAME_RE = /^[a-z0-9-]+$/;

export interface Skill {
  /** Machine name, e.g. "triage-inbox". Must match SKILL_NAME_RE. */
  name: string;
  /** One-line human description of what the skill does. */
  description: string;
  /** Semver-ish version string. */
  version: string;
  /** Ordered human-readable steps distilled from a transcript. */
  steps: string[];
  /** Unique tool names used, in order of first use. */
  requiredTools: string[];
  /** Optional provenance, e.g. "learned from run 2026-10-17T08:00:00Z". */
  createdFrom?: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

export function assertValidSkillName(name: string): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(
      `Invalid skill name "${name}": must match ${SKILL_NAME_RE.source} (lowercase letters, digits, dashes)`,
    );
  }
}
