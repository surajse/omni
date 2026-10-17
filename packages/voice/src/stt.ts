// Speech-to-text over an OpenAI-compatible /audio/transcriptions endpoint
// (OpenAI, Groq, local Whisper servers, …). Multipart is hand-rolled with
// Buffers — zero dependencies. API keys are never logged.
import { randomBytes } from 'node:crypto';

export interface SttOptions {
  /** Base URL of the API, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** e.g. whisper-1 */
  model: string;
  /** BCP-47 language hint, e.g. "en". Optional. */
  language?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

function sanitizeFilename(name: string): string {
  const clean = name.replace(/["\\\r\n]/g, '_') || 'audio';
  return clean.length > 100 ? clean.slice(0, 100) : clean;
}

/**
 * Transcribe audio bytes to text. Returns the transcript.
 * Throws on empty input, HTTP errors, or an empty transcript.
 */
export async function transcribe(audio: Buffer, filename: string, opts: SttOptions): Promise<string> {
  if (!opts.apiKey) throw new Error('transcribe: apiKey is required');
  if (!opts.model) throw new Error('transcribe: model is required');
  if (!audio || audio.length === 0) throw new Error('transcribe: empty audio buffer');

  const boundary = '----omni' + randomBytes(16).toString('hex');
  const parts: Buffer[] = [];
  const field = (name: string, value: string): void => {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  };
  field('model', opts.model);
  if (opts.language) field('language', opts.language);
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${sanitizeFilename(filename)}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  parts.push(audio);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const url = `${opts.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: Buffer.concat(parts),
  });
  if (!res.ok) {
    throw new Error(`transcribe failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { text?: unknown };
  if (typeof data.text !== 'string' || data.text.trim().length === 0) {
    throw new Error('transcribe: empty transcript in response');
  }
  return data.text;
}
