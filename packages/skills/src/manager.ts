// File-backed skill manager: <dir>/<name>/SKILL.md + skill.json.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertValidSkillName, type Skill } from './types.js';
import { renderSkillMd } from './learn.js';

export class SkillManager {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private dirFor(name: string): string {
    return join(this.dir, name);
  }

  save(skill: Skill): Skill {
    assertValidSkillName(skill.name);
    const dir = this.dirFor(skill.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'skill.json'), JSON.stringify(skill, null, 2) + '\n');
    writeFileSync(join(dir, 'SKILL.md'), renderSkillMd(skill));
    return skill;
  }

  get(name: string): Skill {
    const path = join(this.dirFor(name), 'skill.json');
    if (!existsSync(path)) {
      throw new Error(`Unknown skill: ${name}`);
    }
    return JSON.parse(readFileSync(path, 'utf8')) as Skill;
  }

  list(): Skill[] {
    let entries: string[];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
    const skills: Skill[] = [];
    for (const name of entries.sort()) {
      try {
        skills.push(this.get(name));
      } catch {
        // Skip directories that are not valid skills.
      }
    }
    return skills;
  }

  remove(name: string): void {
    const dir = this.dirFor(name);
    if (!existsSync(dir)) {
      throw new Error(`Unknown skill: ${name}`);
    }
    rmSync(dir, { recursive: true });
  }

  /**
   * System-prompt fragment describing available skills. Unknown names are
   * ignored (not an error) so callers can pass best-effort lists.
   */
  promptFragment(names?: string[]): string {
    const skills = names ? names.flatMap((n) => this.safeGet(n)) : this.list();
    if (skills.length === 0) return '';
    const lines = ['## Available skills', ''];
    for (const s of skills) {
      lines.push(`- **${s.name}**: ${s.description}`);
      if (s.steps.length > 0) {
        lines.push(`  Steps: ${s.steps.join(' → ')}`);
      }
      if (s.requiredTools.length > 0) {
        lines.push(`  Tools: ${s.requiredTools.map((t) => `\`${t}\``).join(', ')}`);
      }
    }
    lines.push('', 'When a task matches a skill, follow its steps in order.');
    return lines.join('\n');
  }

  private safeGet(name: string): Skill[] {
    try {
      return [this.get(name)];
    } catch {
      return [];
    }
  }
}
