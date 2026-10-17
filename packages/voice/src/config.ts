// Voice configuration from the environment. Returns undefined when voice is
// not configured (STT model + key are the minimum); callers treat that as
// "voice disabled". Key *names* only — values are never printed here.
export interface SttConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface TtsConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice?: string;
}

export interface VoiceConfig {
  stt: SttConfig;
  tts?: TtsConfig;
}

export function voiceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceConfig | undefined {
  const sttModel = env['OMNI_STT_MODEL'];
  const sttKey = env['OMNI_STT_API_KEY'];
  if (!sttModel || !sttKey) return undefined;

  const cfg: VoiceConfig = {
    stt: {
      baseUrl: env['OMNI_STT_BASE_URL'] ?? 'https://api.openai.com/v1',
      apiKey: sttKey,
      model: sttModel,
    },
  };
  const ttsModel = env['OMNI_TTS_MODEL'];
  const ttsKey = env['OMNI_TTS_API_KEY'];
  if (ttsModel && ttsKey) {
    cfg.tts = {
      baseUrl: env['OMNI_TTS_BASE_URL'] ?? 'https://api.openai.com/v1',
      apiKey: ttsKey,
      model: ttsModel,
      voice: env['OMNI_TTS_VOICE'],
    };
  }
  return cfg;
}
