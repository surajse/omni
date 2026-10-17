// Tests for @omni/voice: STT multipart shape, TTS request shape, config parsing.
import { describe, expect, it } from 'vitest';
import { transcribe } from '../src/stt.js';
import { speak, MAX_TTS_CHARS } from '../src/tts.js';
import { voiceConfigFromEnv } from '../src/config.js';

function mockFetchOnce(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return (async (url: string, init?: RequestInit) => handler(url, init ?? {})) as unknown as typeof fetch;
}

const jsonOk = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('transcribe', () => {
  it('posts multipart with model + file and the auth header', async () => {
    const seen: { url: string; init: RequestInit; bodyText: string }[] = [];
    const fetchImpl = mockFetchOnce((url, init) => {
      seen.push({ url, init, bodyText: (init.body as Buffer).toString('latin1') });
      return jsonOk({ text: 'hello world' });
    });
    const text = await transcribe(Buffer.from([1, 2, 3]), 'voice.ogg', {
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'sk-test',
      model: 'whisper-1',
      fetchImpl,
    });
    expect(text).toBe('hello world');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.example.com/v1/audio/transcriptions');
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test');
    expect(headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = seen[0]!.bodyText;
    expect(body).toContain('name="model"');
    expect(body).toContain('whisper-1');
    expect(body).toContain('name="file"; filename="voice.ogg"');
    expect(body).toContain('\x01\x02\x03');
  });

  it('throws on HTTP errors and empty transcripts', async () => {
    const bad = mockFetchOnce(() => jsonOk({ error: 'nope' }, 401));
    await expect(
      transcribe(Buffer.from([1]), 'a.ogg', { baseUrl: 'https://x', apiKey: 'k', model: 'm', fetchImpl: bad }),
    ).rejects.toThrow('HTTP 401');
    const empty = mockFetchOnce(() => jsonOk({ text: '   ' }));
    await expect(
      transcribe(Buffer.from([1]), 'a.ogg', { baseUrl: 'https://x', apiKey: 'k', model: 'm', fetchImpl: empty }),
    ).rejects.toThrow('empty transcript');
  });

  it('rejects empty audio and missing credentials', async () => {
    const noop = mockFetchOnce(() => jsonOk({ text: 'x' }));
    await expect(transcribe(Buffer.alloc(0), 'a.ogg', { baseUrl: 'https://x', apiKey: 'k', model: 'm', fetchImpl: noop })).rejects.toThrow('empty audio');
    await expect(transcribe(Buffer.from([1]), 'a.ogg', { baseUrl: 'https://x', apiKey: '', model: 'm', fetchImpl: noop })).rejects.toThrow('apiKey');
  });
});

describe('speak', () => {
  it('posts the OpenAI speech JSON shape and returns bytes', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = mockFetchOnce((url, init) => {
      seen.push({ url, init });
      return new Response(Buffer.from([9, 9, 9]), { status: 200 });
    });
    const audio = await speak('hello', {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'tts-1',
      voice: 'nova',
      format: 'mp3',
      fetchImpl,
    });
    expect(audio).toEqual(Buffer.from([9, 9, 9]));
    expect(seen[0]!.url).toBe('https://api.example.com/v1/audio/speech');
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test');
    const payload = JSON.parse(seen[0]!.init.body as string) as Record<string, string>;
    expect(payload).toMatchObject({ model: 'tts-1', input: 'hello', voice: 'nova', response_format: 'mp3' });
  });

  it('rejects empty and over-long text, and HTTP errors', async () => {
    const noop = mockFetchOnce(() => new Response(Buffer.from([1]), { status: 200 }));
    await expect(speak('   ', { baseUrl: 'https://x', apiKey: 'k', model: 'm', fetchImpl: noop })).rejects.toThrow('empty text');
    await expect(
      speak('x'.repeat(MAX_TTS_CHARS + 1), { baseUrl: 'https://x', apiKey: 'k', model: 'm', fetchImpl: noop }),
    ).rejects.toThrow('too long');
    const bad = mockFetchOnce(() => new Response('err', { status: 500 }));
    await expect(speak('hi', { baseUrl: 'https://x', apiKey: 'k', model: 'm', fetchImpl: bad })).rejects.toThrow('HTTP 500');
  });
});

describe('voiceConfigFromEnv', () => {
  it('returns undefined without STT model+key', () => {
    expect(voiceConfigFromEnv({})).toBeUndefined();
    expect(voiceConfigFromEnv({ OMNI_STT_MODEL: 'whisper-1' })).toBeUndefined();
  });

  it('builds STT config with defaults and optional TTS', () => {
    const cfg = voiceConfigFromEnv({ OMNI_STT_MODEL: 'whisper-1', OMNI_STT_API_KEY: 'k' });
    expect(cfg?.stt).toMatchObject({ baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', apiKey: 'k' });
    expect(cfg?.tts).toBeUndefined();
    const full = voiceConfigFromEnv({
      OMNI_STT_MODEL: 'whisper-1',
      OMNI_STT_API_KEY: 'k1',
      OMNI_STT_BASE_URL: 'https://groq.example/v1',
      OMNI_TTS_MODEL: 'tts-1',
      OMNI_TTS_API_KEY: 'k2',
      OMNI_TTS_VOICE: 'nova',
    });
    expect(full?.stt.baseUrl).toBe('https://groq.example/v1');
    expect(full?.tts).toMatchObject({ model: 'tts-1', apiKey: 'k2', voice: 'nova' });
  });
});
