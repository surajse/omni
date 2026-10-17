# Omni Voice (v1.2)

Speech-to-text and text-to-speech over **OpenAI-compatible audio endpoints** —
`@omni/voice` is a zero-dependency package that speaks the standard
`/audio/transcriptions` and `/audio/speech` HTTP APIs. That means it works
with OpenAI, Groq, DeepSeek, Together, or a local Whisper server with no code
changes — swap `OMNI_STT_BASE_URL` and go.

## Environment

| Variable | Purpose |
|---|---|
| `OMNI_STT_MODEL` | STT model, e.g. `whisper-1`. Setting this **enables** voice input. |
| `OMNI_STT_API_KEY` | API key for the STT endpoint. |
| `OMNI_STT_BASE_URL` | STT endpoint base (default `https://api.openai.com/v1`). |
| `OMNI_TTS_MODEL` | TTS model, e.g. `tts-1`. Setting this (+ key) **enables** audio replies. |
| `OMNI_TTS_API_KEY` | API key for the TTS endpoint. |
| `OMNI_TTS_BASE_URL` | TTS endpoint base (default `https://api.openai.com/v1`). |
| `OMNI_TTS_VOICE` | Voice name, e.g. `alloy` (default `alloy`). |

No keys → voice stays off and everything else works. Keys live in env only;
they are never logged (errors report HTTP status, never request bodies).

## Telegram voice messages

With STT configured, `omni telegram <agent-id>` accepts voice/audio messages:

1. Telegram sends the voice note → the channel calls `getFile`, downloads the
   `.ogg`, and transcribes it.
2. The transcript goes to the agent as the user message (nothing is prefixed —
   the agent just sees the words).
3. If TTS is also configured, the reply comes back as a **voice message**
   (`sendAudio`, mp3) with the text as the caption (Telegram captions cap at
   1024 chars; longer replies are truncated in the caption — the audio carries
   the full text). Without TTS, replies stay text.

If voice is *not* configured, the bot answers voice notes politely:
"🎙️ Voice messages are not enabled for this bot yet."

Limits: TTS input is capped at 4000 characters (clear error above that —
split long replies or let them go as text). STT audio uploads have no
client-side size cap; your provider's limits apply.

## Using `@omni/voice` directly

```ts
import { transcribe, speak, voiceConfigFromEnv } from '@omni/voice';

const cfg = voiceConfigFromEnv(); // undefined when not configured
if (cfg) {
  const text = await transcribe(audioBytes, 'note.ogg', { ...cfg.stt });
  const mp3 = await speak('Hello!', { ...cfg.tts! });
}
```

## Cost note

STT/TTS calls bill against your provider account per second/character.
Voice notes are small; a 30s note is typically a few cents on hosted APIs
and free on a local Whisper server.
