// Deterministic skill learning: compress a tool-call sequence into human-readable steps.
import { assertValidSkillName, type Skill } from './types.js';

export interface LearnedCall {
  name: string;
  args: Record<string, unknown>;
}

/** Runs of 3+ consecutive identical tool names collapse into one "Repeat N×" step. */
const REPEAT_THRESHOLD = 3;
const MAX_ARGS_PREVIEW = 120;

function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return 'no arguments';
  const raw = JSON.stringify(args);
  const preview = raw.length > MAX_ARGS_PREVIEW ? raw.slice(0, MAX_ARGS_PREVIEW) + '…' : raw;
  return `with ${preview}`;
}

function stepFor(call: LearnedCall): string {
  return `Call ${call.name} ${summarizeArgs(call.args)}`;
}

/**
 * Distill a skill from an ordered tool-call sequence (e.g. a run transcript).
 * Pure and deterministic: the same calls always produce the same skill.
 */
export function learnSkillFromTranscript(
  name: string,
  description: string,
  calls: LearnedCall[],
  opts: { createdFrom?: string; version?: string } = {},
): Skill {
  assertValidSkillName(name);
  if (!description.trim()) {
    throw new Error('learnSkillFromTranscript: description must not be empty');
  }

  const steps: string[] = [];
  const requiredTools: string[] = [];
  const seen = new Set<string>();

  let i = 0;
  while (i < calls.length) {
    const call = calls[i]!;
    if (!seen.has(call.name)) {
      seen.add(call.name);
      requiredTools.push(call.name);
    }
    // Count the run of consecutive identical tool names.
    let run = 1;
    while (i + run < calls.length && calls[i + run]!.name === call.name) run++;
    if (run >= REPEAT_THRESHOLD) {
      steps.push(`Repeat ${run}×: Call ${call.name} ${summarizeArgs(call.args)}`);
    } else {
      for (let k = 0; k < run; k++) steps.push(stepFor(calls[i + k]!));
    }
    i += run;
  }

  return {
    name,
    description: description.trim(),
    version: opts.version ?? '1.0.0',
    steps,
    requiredTools,
    createdFrom: opts.createdFrom,
    createdAt: new Date().toISOString(),
  };
}

/** Render a skill as SKILL.md (human-readable, git-friendly). */
export function renderSkillMd(skill: Skill): string {
  const lines = [
    `# ${skill.name}`,
    '',
    `> ${skill.description}`,
    '',
    `Version: ${skill.version}`,
    ...(skill.createdFrom ? [`Learned from: ${skill.createdFrom}`] : []),
    `Created: ${skill.createdAt}`,
    '',
    '## Steps',
    '',
  ];
  if (skill.steps.length === 0) {
    lines.push('_No tool calls were recorded for this skill._', '');
  } else {
    skill.steps.forEach((step, idx) => lines.push(`${idx + 1}. ${step}`));
    lines.push('');
  }
  lines.push('## Required tools', '');
  for (const tool of skill.requiredTools) lines.push(`- \`${tool}\``);
  if (skill.requiredTools.length === 0) lines.push('_None._');
  lines.push(
    '',
    '## Usage',
    '',
    'When the user asks for something this skill covers, follow the steps above in order,',
    'calling the listed tools. Ask for approval before any write-class action unless your',
    'policy already allows it.',
    '',
  );
  return lines.join('\n');
}
