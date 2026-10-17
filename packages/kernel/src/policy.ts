// Policy engine: decides whether a tool call may run, must ask, or is denied.
import type { PolicyRule } from './types.js';

export type PolicyDecision = 'allow' | 'ask' | 'deny';

export type ApprovalHandler = (req: {
  tool: string;
  args: Record<string, unknown>;
}) => Promise<boolean>;

function matches(pattern: string, toolName: string): boolean {
  if (pattern.endsWith('*')) {
    // Trailing `*` / `**` acts as a prefix wildcard.
    return toolName.startsWith(pattern.replace(/\*+$/, ''));
  }
  return pattern === toolName;
}

export class PolicyEngine {
  constructor(private readonly rules: PolicyRule[]) {}

  decide(toolName: string, readOnly: boolean): PolicyDecision {
    for (const rule of this.rules) {
      if (matches(rule.match, toolName)) {
        return rule.effect;
      }
    }
    // Default: reads run freely, writes ask first.
    return readOnly ? 'allow' : 'ask';
  }
}
