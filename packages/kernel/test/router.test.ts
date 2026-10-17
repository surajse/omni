import { describe, expect, it } from 'vitest';
import { RoutingProvider, isRetryableProviderError } from '../src/router.js';
import type { ModelProvider } from '../src/providers.js';
import type { ProviderEntry } from '../src/types.js';

const ENTRIES: ProviderEntry[] = [
  { id: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k1', models: ['gpt-4o-mini'] },
  { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k2', models: ['llama-3.3-70b'] },
  { id: 'local', baseUrl: 'http://localhost:11434/v1', apiKey: 'k3', models: ['qwen3'] },
];

/** Scripted provider: each call either throws the next error or returns the reply. */
function scripted(name: string, script: Array<Error | { text: string }>): ModelProvider & { calls: number } {
  const p = {
    name,
    calls: 0,
    async complete() {
      p.calls++;
      const next = script.shift();
      if (next instanceof Error) throw next;
      return { text: next?.text ?? 'ok', toolCalls: [] };
    },
  };
  return p;
}

function routerWith(
  scriptById: Record<string, Array<Error | { text: string }>>,
  opts: { model?: string; rules?: Array<{ match: string; providerId: string }>; maxFallbacks?: number } = {},
): { router: RoutingProvider; fallbacks: Array<{ from: string; to: string; reason: string }>; seen: Record<string, number> } {
  const fallbacks: Array<{ from: string; to: string; reason: string }> = [];
  const seen: Record<string, number> = {};
  const providers = new Map<string, ReturnType<typeof scripted>>();
  const router = new RoutingProvider({
    entries: ENTRIES,
    rules: opts.rules,
    defaultModel: opts.model ?? 'gpt-4o-mini',
    maxFallbacks: opts.maxFallbacks,
    makeProvider: (entry, _model) => {
      let p = providers.get(entry.id);
      if (!p) {
        p = scripted(entry.id, scriptById[entry.id] ?? [{ text: `from-${entry.id}` }]);
        providers.set(entry.id, p);
      }
      const orig = p.complete.bind(p);
      p.complete = async (...a) => {
        seen[entry.id] = (seen[entry.id] ?? 0) + 1;
        return orig(...a);
      };
      return p;
    },
    onFallback: (info) => fallbacks.push(info),
  });
  return { router, fallbacks, seen };
}

const http500 = () => new Error('OpenAI-compatible request failed with HTTP 500 Internal Server Error');
const http429 = () => new Error('OpenAI-compatible request failed with HTTP 429 Too Many Requests');
const netErr = () => new Error('OpenAI-compatible request to https://api.openai.com/v1 failed: fetch failed');
const http400 = () => new Error('OpenAI-compatible request failed with HTTP 400 Bad Request');

describe('isRetryableProviderError', () => {
  it('retries 429, 5xx and network failures; fails fast otherwise', () => {
    expect(isRetryableProviderError(http500())).toBe(true);
    expect(isRetryableProviderError(http429())).toBe(true);
    expect(isRetryableProviderError(netErr())).toBe(true);
    expect(isRetryableProviderError(http400())).toBe(false);
    expect(isRetryableProviderError(new Error('OpenAI-compatible request failed with HTTP 401'))).toBe(false);
    expect(isRetryableProviderError(new Error('some other bug'))).toBe(false);
  });
});

describe('RoutingProvider.resolve', () => {
  it('prefers an explicit <providerId>:<model> prefix', () => {
    const r = new RoutingProvider({ entries: ENTRIES, defaultModel: 'x' });
    expect(r.resolve('groq:llama-3.3-70b')).toMatchObject({ model: 'llama-3.3-70b' });
    expect(r.resolve('groq:llama-3.3-70b').entry.id).toBe('groq');
  });

  it('matches models lists, then falls back to the first entry', () => {
    const r = new RoutingProvider({ entries: ENTRIES, defaultModel: 'x' });
    expect(r.resolve('qwen3').entry.id).toBe('local');
    expect(r.resolve('mystery-model').entry.id).toBe('openai');
    expect(r.resolve('mystery-model').model).toBe('mystery-model');
  });

  it('applies routing rules in order before the models list', () => {
    const r = new RoutingProvider({
      entries: ENTRIES,
      defaultModel: 'x',
      rules: [
        { match: '^code-', providerId: 'groq' },
        { match: '.*', providerId: 'local' },
      ],
    });
    expect(r.resolve('code-review').entry.id).toBe('groq');
    expect(r.resolve('anything-else').entry.id).toBe('local');
  });

  it('rejects bad configs fast', () => {
    expect(() => new RoutingProvider({ entries: [], defaultModel: 'x' })).toThrow(/at least one/);
    expect(
      () =>
        new RoutingProvider({
          entries: [...ENTRIES, { id: 'openai', baseUrl: 'u', apiKey: 'k', models: [] }],
          defaultModel: 'x',
        }),
    ).toThrow(/duplicate/);
    expect(
      () => new RoutingProvider({ entries: ENTRIES, defaultModel: 'x', rules: [{ match: '([', providerId: 'groq' }] }),
    ).toThrow(/invalid routing regex/);
    expect(
      () => new RoutingProvider({ entries: ENTRIES, defaultModel: 'x', rules: [{ match: 'x', providerId: 'nope' }] }),
    ).toThrow(/unknown provider/);
  });
});

describe('RoutingProvider.complete', () => {
  it('serves from the primary when healthy', async () => {
    const { router, seen, fallbacks } = routerWith({});
    const res = await router.complete({ messages: [], tools: [] });
    expect(res.text).toBe('from-openai');
    expect(seen).toEqual({ openai: 1 });
    expect(fallbacks).toHaveLength(0);
  });

  it('falls back on 500/429/network errors and reports the switch', async () => {
    const { router, seen, fallbacks } = routerWith({ openai: [http500()], groq: [{ text: 'groq saved us' }] });
    const res = await router.complete({ messages: [], tools: [] });
    expect(res.text).toBe('groq saved us');
    expect(seen).toEqual({ openai: 1, groq: 1 });
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({ from: 'openai', to: 'groq' });
    expect(fallbacks[0]!.reason).toContain('500');
  });

  it('chains multiple fallbacks up to the cap', async () => {
    const { router, seen } = routerWith(
      { openai: [http429()], groq: [netErr()], local: [{ text: 'local wins' }] },
      { maxFallbacks: 5 },
    );
    const res = await router.complete({ messages: [], tools: [] });
    expect(res.text).toBe('local wins');
    expect(seen).toEqual({ openai: 1, groq: 1, local: 1 });
  });

  it('respects maxFallbacks', async () => {
    const { router, seen } = routerWith(
      { openai: [http500()], groq: [http500()], local: [{ text: 'unreached' }] },
      { maxFallbacks: 1 },
    );
    await expect(router.complete({ messages: [], tools: [] })).rejects.toThrow(/all providers failed \(openai, groq\)/);
    expect(seen['local']).toBeUndefined();
  });

  it('does not retry non-retryable errors', async () => {
    const { router, seen, fallbacks } = routerWith({ openai: [http400()] });
    await expect(router.complete({ messages: [], tools: [] })).rejects.toThrow(/400/);
    expect(seen).toEqual({ openai: 1 });
    expect(fallbacks).toHaveLength(0);
  });

  it('resolves apiKey from apiKeyEnv and errors clearly when unset', async () => {
    const entries: ProviderEntry[] = [{ id: 'e', baseUrl: 'https://x', apiKeyEnv: 'OMNI_TEST_MISSING_KEY_XYZ', models: [] }];
    const r = new RoutingProvider({ entries, defaultModel: 'm' });
    await expect(r.complete({ messages: [], tools: [] })).rejects.toThrow(/OMNI_TEST_MISSING_KEY_XYZ/);
    const noKey: ProviderEntry[] = [{ id: 'e', baseUrl: 'https://x', models: [] }];
    const r2 = new RoutingProvider({ entries: noKey, defaultModel: 'm' });
    await expect(r2.complete({ messages: [], tools: [] })).rejects.toThrow(/neither apiKeyEnv nor apiKey/);
  });
});
