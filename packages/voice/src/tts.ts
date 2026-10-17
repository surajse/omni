// Text-to-speech over an OpenAI-compatible /audio/speech endpoint.
// Returns raw audio bytes (mp3 by default). Zero dependencies.
export interface TtsOptions {
  /** Base URL of the API, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** e.g. tts-1 */
  model: string;
  /** e.g. alloy */
  voice?: string;
  format?: 'mp3' | 'wav' | 'opus' | 'flac';
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Providers reject very long inputs; fail fast with a clear message. */
export const MAX_TTS_CHARS = 4000;

/**
 * Synthesize text to audio bytes. Throws on empty input, over-long input,
 * HTTP errors, or an empty audio response.
 */
export async function speak(text: string, opts: TtsOptions): Promise<Buffer> {
  if (!opts.apiKey) throw new Error('speak: apiKey is required');
  if (!opts.model) throw new Error('speak: model is required');
  if (!text || text.trim().length === 0) throw new Error('speak: empty text');
  if (text.length > MAX_TTS_CHARS) {
    throw new Error(`speak: text too long (${text.length} > ${MAX_TTS_CHARS} chars)`);
  }

  const url = `${opts.baseUrl.replace(/\/+$/, '')}/audio/speech`;
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      input: text,
      voice: opts.voice ?? 'alloy',
      response_format: opts.format ?? 'mp3',
    }),
  });
  if (!res.ok) {
    throw new Error(`speak failed: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('speak: empty audio in response');
  return buf;
}
