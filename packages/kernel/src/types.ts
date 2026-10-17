// Core types for the Omni agent kernel.

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the tool's arguments. */
  parameters: Record<string, unknown>;
  readOnly: boolean;
}

export interface ToolResult {
  call: ToolCall;
  output: string;
  error?: string;
}

export interface ModelConfig {
  provider: 'openai-compatible' | 'mock';
  baseUrl?: string;
  apiKeyEnv?: string;
  model: string;
}

/** `match` supports a trailing `*` (or `**`) prefix wildcard; anything else is exact. */
export interface PolicyRule {
  match: string;
  effect: 'allow' | 'ask' | 'deny';
}

export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  model: ModelConfig;
  systemPrompt: string;
  /** Tool names this agent may use. Empty means all registered tools. */
  tools: string[];
  policy: PolicyRule[];
  memoryNamespace: string;
}

export type RunEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'approval'; call: ToolCall; decision: 'approved' | 'denied' | 'skipped' }
  | { type: 'tool-result'; result: ToolResult }
  | { type: 'done'; output: string };
