// @omni/voice: speech-to-text and text-to-speech over OpenAI-compatible
// audio endpoints. Zero dependencies.
export { transcribe, type SttOptions } from './stt.js';
export { speak, MAX_TTS_CHARS, type TtsOptions } from './tts.js';
export { voiceConfigFromEnv, type VoiceConfig, type SttConfig, type TtsConfig } from './config.js';
