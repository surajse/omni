// MCP (Model Context Protocol) tool source over stdio.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolDefinition } from './types.js';
import type { ToolGateway } from './tools.js';

export interface McpServerOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Heuristic: tools whose names look like reads are treated as read-only. */
const READONLY_PREFIXES = ['get_', 'list_', 'read_', 'search_', 'query_'];

interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export class McpToolSource {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private tools: ToolDefinition[] = [];

  constructor(options: McpServerOptions) {
    this.client = new Client({ name: 'omni-mcp', version: '0.1.0' }, { capabilities: {} });
    this.transport = new StdioClientTransport({
      command: options.command,
      args: options.args,
      env: options.env,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<ToolDefinition[]> {
    const res = await this.client.listTools();
    this.tools = res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      readOnly: READONLY_PREFIXES.some((p) => t.name.startsWith(p)),
    }));
    return this.tools;
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.client.callTool({ name, arguments: args });
    const blocks = res.content as McpContentBlock[];
    return blocks
      .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(b)))
      .join('\n');
  }

  /** Register every tool from this server on the gateway. */
  async attach(gateway: ToolGateway): Promise<void> {
    const tools = this.tools.length > 0 ? this.tools : await this.listTools();
    for (const def of tools) {
      gateway.register(def, (args) => this.call(def.name, args));
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
