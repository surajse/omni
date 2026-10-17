// Embeddings via any OpenAI-compatible /embeddings endpoint, plus cosine similarity.
// The API key is sent as a Bearer header and never logged.
export interface EmbedOptions {
  /** Base URL of the OpenAI-compatible API, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** Embedding model, e.g. "text-embedding-3-small". */
  model: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Embed `texts` (in order) with an OpenAI-compatible embeddings endpoint. */
export async function embed(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  if (texts.length === 0) return [];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetchImpl(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({ model: opts.model, input: texts }),
    });
  } catch (err) {
    throw new Error(`embeddings request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new Error(`embeddings request failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    data?: Array<{ embedding?: unknown; index?: unknown }>;
  };
  if (!Array.isArray(data.data)) {
    throw new Error('embeddings request failed: malformed response (missing data[])');
  }
  const sorted = [...data.data].sort(
    (a, b) => (typeof a.index === 'number' ? a.index : 0) - (typeof b.index === 'number' ? b.index : 0),
  );
  return sorted.map((d, i) => {
    if (!Array.isArray(d.embedding) || !d.embedding.every((n) => typeof n === 'number')) {
      throw new Error(`embeddings request failed: malformed embedding at index ${i}`);
    }
    return d.embedding as number[];
  });
}

/** Cosine similarity in [-1, 1]. Returns 0 when either vector is all zeros. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
