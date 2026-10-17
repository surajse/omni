// ModelRouter: per-task provider routing + fallback for OpenAI-compatible
// providers. An agent's `model.model` string is a *model reference* resolved
// per request:
//
//   1. `<providerId>:<model>` prefix  -> that provider, that model
//   2. first `routing` rule whose regex matches the reference -> its provider
//   3. first entry whose `models` list contains the reference -> that provider
//   4. otherwise the first entry (with the reference as the model name)
//
// On retryable failures (HTTP 429 / 5xx, network errors) the router falls
// back to the remaining providers in listed order (max 2 by default) and
// reports which provider served the request via `onFallback`.
import type { ModelProvider } from './providers.js';
import { OpenAICompatibleProvider } from './providers.js';
import type { ProviderEntry, RoutingRule, ToolCall, ToolDefinition, ChatMessage } from './types.js';

export interface FallbackInfo {
  from: string;
  to: string;
  reason: string;
}

export interface RoutingProviderOptions {
  entries: ProviderEntry[];
  /** First rule whose regex matches the model reference wins. */
  rules?: RoutingRule[];
  /** The agent's model reference (see resolution order above). */
  defaultModel: string;
  /** Max fallbacks after the primary. Default 2. */
  maxFallbacks?: number;
  /** Injectable provider factory for tests. */
  makeProvider?: (entry: ProviderEntry, model: string) => ModelProvider;
  onFallback?: (info: FallbackInfo) => void;
}

/**
 * True for errors worth retrying on another provider: HTTP 429 / 5xx and
 * network-level failures. Everything else (400, 401, 404, malformed
 * responses) fails fast so auth/config bugs surface immediately.
 */
export function isRetryableProviderError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/HTTP\s+(429|5\d\d)\b/.test(msg)) return true;
  // OpenAICompatibleProvider network failures read "... request to <url> failed: ...".
  if (/request to \S+ failed:/.test(msg)) return true;
  return false;
}

function resolveApiKey(entry: ProviderEntry): string {
  if (entry.apiKeyEnv) {
    const v = process.env[entry.apiKeyEnv];
    if (!v) throw new Error(`RoutingProvider: env var ${entry.apiKeyEnv} is not set (provider "${entry.id}")`);
    return v;
  }
  if (entry.apiKey) return entry.apiKey;
  throw new Error(`RoutingProvider: provider "${entry.id}" has neither apiKeyEnv nor apiKey`);
}

export class RoutingProvider implements ModelProvider {
  readonly name = 'routing';
  private readonly entries: ProviderEntry[];
  private readonly rules: Array<{ re: RegExp; providerId: string }>;
  private readonly defaultModel: string;
  private readonly maxFallbacks: number;
  private readonly makeProvider: (entry: ProviderEntry, model: string) => ModelProvider;
  private readonly onFallback?: (info: FallbackInfo) => void;

  constructor(opts: RoutingProviderOptions) {
    if (opts.entries.length === 0) {
      throw new Error('RoutingProvider: at least one provider entry is required');
    }
    const ids = new Set<string>();
    for (const e of opts.entries) {
      if (!e.id) throw new Error('RoutingProvider: every provider entry needs an id');
      if (ids.has(e.id)) throw new Error(`RoutingProvider: duplicate provider id "${e.id}"`);
      ids.add(e.id);
    }
    this.rules = (opts.rules ?? []).map((r) => {
      let re: RegExp;
      try {
        re = new RegExp(r.match);
      } catch {
        throw new Error(`RoutingProvider: invalid routing regex "${r.match}"`);
      }
      return { re, providerId: r.providerId };
    });
    for (const r of this.rules) {
      if (!ids.has(r.providerId)) {
        throw new Error(`RoutingProvider: routing rule points at unknown provider "${r.providerId}"`);
      }
    }
    this.entries = opts.entries;
    this.defaultModel = opts.defaultModel;
    this.maxFallbacks = opts.maxFallbacks ?? 2;
    this.onFallback = opts.onFallback;
    this.makeProvider =
      opts.makeProvider ??
      ((entry, model) =>
        new OpenAICompatibleProvider({ baseUrl: entry.baseUrl, apiKey: resolveApiKey(entry), model }));
  }

  /** Resolve the model reference to a provider + concrete model name. Exported for tests. */
  resolve(modelRef: string): { entry: ProviderEntry; model: string } {
    const colon = modelRef.indexOf(':');
    if (colon > 0) {
      const prefix = modelRef.slice(0, colon);
      const entry = this.entries.find((e) => e.id === prefix);
      if (entry) return { entry, model: modelRef.slice(colon + 1) };
    }
    for (const r of this.rules) {
      if (r.re.test(modelRef)) {
        const entry = this.entries.find((e) => e.id === r.providerId)!;
        return { entry, model: modelRef };
      }
    }
    const listed = this.entries.find((e) => e.models.includes(modelRef));
    if (listed) return { entry: listed, model: modelRef };
    return { entry: this.entries[0]!, model: modelRef };
  }

  async complete(req: {
    messages: ChatMessage[];
    tools: ToolDefinition[];
  }): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const primary = this.resolve(this.defaultModel);
    const ordered = [
      primary,
      ...this.entries.filter((e) => e.id !== primary.entry.id).map((entry) => ({ entry, model: this.defaultModel })),
    ].slice(0, 1 + this.maxFallbacks);

    let lastError: unknown = null;
    for (let i = 0; i < ordered.length; i++) {
      const { entry, model } = ordered[i]!;
      try {
        return await this.makeProvider(entry, model).complete(req);
      } catch (err) {
        if (!isRetryableProviderError(err)) throw err;
        lastError = err;
        const next = ordered[i + 1];
        this.onFallback?.({
          from: entry.id,
          to: next ? next.entry.id : '(none left)',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const tried = ordered.map((o) => o.entry.id).join(', ');
    throw new Error(
      `RoutingProvider: all providers failed (${tried}): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}
