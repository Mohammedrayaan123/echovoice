import { parseBuffer } from "music-metadata";
import { VoiceServiceError } from "./voiceService.js";

const BASE_URL = "https://api.elevenlabs.io/v1";
const REFERENCE_MODEL_ID = "eleven_multilingual_v2";
const REFERENCE_SETTINGS = Object.freeze({ stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true });

function providerError(status, body) {
  const detail = body?.detail?.code || body?.detail?.status || body?.code;
  if (status === 401 || status === 403) return new VoiceServiceError("Voice service authentication failed.", "auth_error", 503);
  if (status === 429) return new VoiceServiceError("The voice service is busy.", "rate_limited", 429);
  if (["quota_exceeded", "insufficient_credits"].includes(detail)) return new VoiceServiceError("The voice account has used its available credits.", "quota_exceeded", 402);
  return new VoiceServiceError("The reference reading could not be generated.", "reference_generation_failed", 502);
}

async function durationFromAudio(audio, alignment) {
  const ends = alignment?.character_end_times_seconds;
  if (Array.isArray(ends) && ends.length) {
    const duration = Math.max(...ends.filter(Number.isFinite));
    if (Number.isFinite(duration) && duration > 0) return duration;
  }
  try {
    const metadata = await parseBuffer(audio, { mimeType: "audio/mpeg", size: audio.length }, { duration: true, skipCovers: true });
    if (Number.isFinite(metadata.format.duration) && metadata.format.duration > 0) return metadata.format.duration;
  } catch { /* The safe error below covers unsupported or malformed audio. */ }
  throw new VoiceServiceError("The reference reading duration could not be measured.", "reference_audio_invalid", 502);
}

export function createElevenLabsClient({ apiKey, referenceVoiceId, fetchImpl = globalThis.fetch, timeoutMs = 120_000 } = {}) {
  return {
    async generateReference(script) {
      if (!apiKey || !referenceVoiceId) throw new VoiceServiceError("Reference generation is not configured.", "not_configured", 503);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${BASE_URL}/text-to-speech/${encodeURIComponent(referenceVoiceId)}/with-timestamps?output_format=mp3_44100_128`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
          body: JSON.stringify({ text: script, model_id: REFERENCE_MODEL_ID, voice_settings: REFERENCE_SETTINGS }),
          signal: controller.signal,
        });
        let body;
        try { body = await response.json(); } catch { body = null; }
        if (!response.ok) throw providerError(response.status, body);
        if (typeof body?.audio_base64 !== "string" || !body.audio_base64) {
          throw new VoiceServiceError("The reference reading returned no audio.", "reference_audio_invalid", 502);
        }
        const audio = Buffer.from(body.audio_base64, "base64");
        if (!audio.length) throw new VoiceServiceError("The reference reading returned no audio.", "reference_audio_invalid", 502);
        const alignment = body.alignment || body.normalized_alignment || null;
        return { audio, mimeType: "audio/mpeg", alignment, durationSeconds: await durationFromAudio(audio, alignment) };
      } catch (error) {
        if (controller.signal.aborted) throw new VoiceServiceError("The reference reading took too long.", "timeout", 504);
        if (error instanceof VoiceServiceError) throw error;
        throw new VoiceServiceError("The server could not reach the voice service.", "provider_network_error", 502);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

