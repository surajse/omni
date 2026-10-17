import { describe, expect, it, vi } from 'vitest';
import { cosine, embed } from '../src/vector.js';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('cosine', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('returns 0 when a vector is all zeros', () => {
    expect(cosine([0, 0], [1, 2])).toBe(0);
  });

  it('throws on dimension mismatch', () => {
    expect(() => cosine([1, 2], [1, 2, 3])).toThrow(/dimension mismatch/);
  });
});

describe('embed', () => {
  const opts = { baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-test', model: 'emb-1' };

  it('POSTs to /embeddings with the right shape and auth', async () => {
    const seen: Array<{ url: unknown; init?: Parameters<typeof fetch>[1] }> = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: Parameters<typeof fetch>[1]) => {
      seen.push({ url, init });
      return jsonResponse({ data: [{ embedding: [0.1, 0.2], index: 0 }] });
    });
    const out = await embed(['hello'], { ...opts, fetchImpl: fetchImpl as typeof fetch });
    expect(out).toEqual([[0.1, 0.2]]);
    expect(String(seen[0]?.url)).toBe('https://api.example.com/v1/embeddings');
    const init = seen[0]?.init as { headers: Record<string, string>; body: string };
    expect(init.headers['authorization']).toBe('Bearer sk-test');
    expect(JSON.parse(init.body)).toEqual({ model: 'emb-1', input: ['hello'] });
  });

  it('returns embeddings in index order', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        data: [
          { embedding: [2], index: 1 },
          { embedding: [1], index: 0 },
        ],
      })) as typeof fetch;
    const out = await embed(['a', 'b'], { ...opts, fetchImpl });
    expect(out).toEqual([[1], [2]]);
  });

  it('returns [] for empty input without calling fetch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await embed([], { ...opts, fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on non-2xx without leaking the key', async () => {
    const fetchImpl = (async () => jsonResponse({ error: 'nope' }, 401)) as typeof fetch;
    await expect(embed(['x'], { ...opts, fetchImpl })).rejects.toThrow(/HTTP 401/);
    await expect(embed(['x'], { ...opts, fetchImpl })).rejects.not.toThrow(/sk-test/);
  });

  it('throws on malformed responses', async () => {
    const fetchImpl = (async () => jsonResponse({ data: 'nope' })) as typeof fetch;
    await expect(embed(['x'], { ...opts, fetchImpl })).rejects.toThrow(/malformed/);
  });
});
