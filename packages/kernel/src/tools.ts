// Tool registry + execution gateway.
import type { ToolDefinition } from './types.js';

export type ToolHandler = (args: Record<string, unknown>) => string | Promise<string>;

export class ToolGateway {
  private readonly defs = new Map<string, ToolDefinition>();
  private readonly handlers = new Map<string, ToolHandler>();

  register(def: ToolDefinition, handler: ToolHandler): void {
    this.defs.set(def.name, def);
    this.handlers.set(def.name, handler);
  }

  list(): ToolDefinition[] {
    return [...this.defs.values()];
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return await handler(args);
  }
}
