// Agent-to-agent handoff: the `agent.handoff` tool delegates a task to another agent.
import { Agent, type AgentDeps } from './agent.js';
import type { AgentConfig, ToolDefinition } from './types.js';
import type { AgentRegistry } from './registry.js';
import type { ToolGateway } from './tools.js';

export interface HandoffOptions {
  registry: AgentRegistry;
  /**
   * Build a fresh AgentDeps for the target agent. Called once per handoff;
   * the returned gateway must be fresh (the nested handoff tool is registered
   * into it with depth+1). Run-scoped approve/onEvent can be closed over here.
   */
  makeDeps: (config: AgentConfig) => AgentDeps;
  /** Maximum successful handoffs in one chain (default 3). */
  maxDepth?: number;
  /** Current depth of this tool instance (0 at the top level). */
  depth?: number;
}

const HANDOFF_DEF: ToolDefinition = {
  name: 'agent.handoff',
  description:
    'Delegate a task to another agent by id. The other agent runs the task and its final answer is returned. Use when a specialist agent fits the job better.',
  parameters: {
    type: 'object',
    properties: {
      to_agent: { type: 'string', description: 'Id of the agent to hand the task to.' },
      task: { type: 'string', description: 'The task for the other agent, with all needed context.' },
    },
    required: ['to_agent', 'task'],
  },
  // Write-class: policy defaults to `ask`, so delegation is always a conscious choice.
  readOnly: false,
};

/**
 * Create the `agent.handoff` tool. The returned handler closes over `depth`;
 * nested handoffs get depth+1 and throw once `maxDepth` is reached.
 */
export function createHandoffTool(opts: HandoffOptions): {
  def: ToolDefinition;
  handler: (args: Record<string, unknown>) => Promise<string>;
} {
  const depth = opts.depth ?? 0;
  const maxDepth = opts.maxDepth ?? 3;

  async function handler(args: Record<string, unknown>): Promise<string> {
    if (depth >= maxDepth) {
      throw new Error(`agent.handoff: handoff depth exceeded (max ${maxDepth})`);
    }
    const to = args['to_agent'];
    const task = args['task'];
    if (typeof to !== 'string' || !to.trim()) {
      throw new Error('agent.handoff: "to_agent" must be a non-empty string');
    }
    if (typeof task !== 'string' || !task.trim()) {
      throw new Error('agent.handoff: "task" must be a non-empty string');
    }
    const target: AgentConfig = opts.registry.get(to); // throws "Unknown agent: <id>"
    const deps = opts.makeDeps(target);
    // The sub-agent gets its own handoff tool at depth+1, so chains keep working
    // until the guard above fires with an explicit "depth exceeded" error.
    const nested = createHandoffTool({ ...opts, depth: depth + 1 });
    deps.gateway.register(nested.def, nested.handler);
    const sub = new Agent(target, deps);
    return await sub.run(task);
  }

  return { def: HANDOFF_DEF, handler };
}

/** Convenience: register `agent.handoff` on a gateway. */
export function registerHandoffTool(gateway: ToolGateway, opts: HandoffOptions): void {
  const { def, handler } = createHandoffTool(opts);
  gateway.register(def, handler);
}
