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

/**
 * One entry in an agent's multi-provider setup. `apiKeyEnv` (name of an
 * environment variable holding the key) is preferred; a literal `apiKey`
 * is discouraged (it would land in the agent JSON on disk).
 */
export interface ProviderEntry {
  id: string;
  baseUrl: string;
  apiKeyEnv?: string;
  apiKey?: string;
  /** Model names this provider serves (matched against the agent's model). */
  models: string[];
}

/** Per-task routing: the first rule whose regex matches the model ref wins. */
export interface RoutingRule {
  match: string;
  providerId: string;
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
  /**
   * Optional multi-provider setup. When present (non-empty), the agent's
   * provider is a ModelRouter over these entries instead of the single
   * `model` provider; `model.model` becomes the model *reference* resolved
   * per request (`<providerId>:<model>`, a routing-rule regex match, or a
   * `models`-list match). Absent = back-compat single-provider behaviour.
   */
  providers?: ProviderEntry[];
  /** Optional per-task routing rules, evaluated in order. */
  routing?: RoutingRule[];
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
