// Keep provider capabilities and credentials on the server.
// Docs: https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech
export const DEFAULT_MODEL_ID = "eleven_multilingual_v2";
export const MODEL_TEXT_LIMITS = Object.freeze({
  eleven_multilingual_v2: 10_000,
  eleven_v3: 5_000,
  eleven_flash_v2_5: 40_000,
});
export const DEFAULT_VOICE_SETTINGS = Object.freeze({
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
});
export const CLONE_TIMEOUT_MS = 180_000;
export const SPEECH_TIMEOUT_MS = 120_000;
export const MAX_AUDIO_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_TOTAL_BYTES = 40 * 1024 * 1024;
const BASE_URL = "https://api.elevenlabs.io/v1";

export class VoiceServiceError extends Error {
  constructor(message, code, status = 502) {
    super(message);
    this.name = "VoiceServiceError";
    this.code = code;
    this.status = status;
  }
}

function numberInRange(value, fallback) {
  // Number(null), Number("") and Number(false) are all zero; none should
  // accidentally turn an omitted control into maximum expressiveness.
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export function resolveVoiceSettings(model, settings = {}) {
  const stability = numberInRange(settings?.stability, DEFAULT_VOICE_SETTINGS.stability);
  if (model === "eleven_v3") {
    // v3 accepts Creative (0), Natural (.5), Robust (1), not a continuous
    // slider. Natural is the closest match to the source recording.
    return { stability: Math.round(stability * 2) / 2 };
  }
  return {
    stability,
    similarity_boost: numberInRange(settings?.similarity_boost, DEFAULT_VOICE_SETTINGS.similarity_boost),
    style: model === "eleven_multilingual_v2" ? numberInRange(settings?.style, 0) : 0,
    use_speaker_boost: DEFAULT_VOICE_SETTINGS.use_speaker_boost,
  };
}

export function validateSpeechInput(body) {
  const { voiceId, text, modelId, languageCode, voiceSettings } = body || {};
  if (typeof voiceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(voiceId)) {
    throw new VoiceServiceError("A valid voice ID is required.", "bad_request", 400);
  }
  if (typeof text !== "string" || !text.trim()) {
    throw new VoiceServiceError("Script text is required.", "bad_request", 400);
  }
  const model = Object.hasOwn(MODEL_TEXT_LIMITS, modelId) ? modelId : DEFAULT_MODEL_ID;
  const cleanText = text.trim();
  if (cleanText.length > MODEL_TEXT_LIMITS[model]) {
    throw new VoiceServiceError(`This model accepts up to ${MODEL_TEXT_LIMITS[model]} characters.`, "text_too_long", 400);
  }
  if (languageCode != null && languageCode !== "" && (typeof languageCode !== "string" || !/^[a-z]{2,3}$/.test(languageCode))) {
    throw new VoiceServiceError("Choose a supported language.", "bad_request", 400);
  }
  const resolvedSettings = resolveVoiceSettings(model, voiceSettings);
  const requestBody = { text: cleanText, model_id: model, voice_settings: resolvedSettings };
  // Multilingual v2 does not support language_code; use automatic detection.
  if (languageCode && model !== "eleven_multilingual_v2") requestBody.language_code = languageCode;
  return { voiceId, model, resolvedSettings, requestBody };
}

function providerError(status, body) {
  const detailCode = body?.detail?.code || body?.detail?.status || body?.code;
  if (detailCode === "voice_not_found" || status === 404) return new VoiceServiceError("Voice not found.", "voice_not_found", 404);
  if (["voice_limit_reached", "voice_limit_exceeded", "maximum_voice_limit_reached"].includes(detailCode)) {
    return new VoiceServiceError("The voice account has no free clone slots.", "voice_limit_reached", 409);
  }
  if (["quota_exceeded", "insufficient_credits"].includes(detailCode)) {
    return new VoiceServiceError("The voice account has used its available credits.", "quota_exceeded", 402);
  }
  if (["voice_requires_verification", "voice_not_verified", "verification_required"].includes(detailCode)) {
    return new VoiceServiceError("This voice needs verification in ElevenLabs.", "verification_required", 409);
  }
  if (["invalid_audio", "invalid_audio_file", "invalid_file"].includes(detailCode)) {
    return new VoiceServiceError("The recording could not be read. Try another audio file.", "invalid_audio", 400);
  }
  if (status === 429) return new VoiceServiceError("The voice service is busy. Please try again shortly.", "rate_limited", 429);
  if (status === 401 || status === 403) return new VoiceServiceError("Voice service authentication failed.", "auth_error", 503);
  if (status === 400 || status === 422) return new VoiceServiceError("The voice service could not use this request.", "bad_request", 400);
  return new VoiceServiceError("The voice service is having issues.", "server_error", 502);
}

export function createVoiceService({ apiKey, fetchImpl = globalThis.fetch, cloneTimeoutMs = CLONE_TIMEOUT_MS, speechTimeoutMs = SPEECH_TIMEOUT_MS, logger = console } = {}) {
  async function request(endpoint, options, timeoutMs) {
    if (!apiKey) throw new VoiceServiceError("Voice generation isn't configured.", "not_configured", 503);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${BASE_URL}${endpoint}`, {
        ...options,
        headers: { ...options.headers, "xi-api-key": apiKey },
        signal: controller.signal,
      });
      // Keep the timer active until JSON/audio is fully read, not just headers.
      let body;
      try {
        body = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (!response.ok) throw providerError(response.status, null);
        throw new VoiceServiceError("The voice service returned an incomplete response.", "server_error");
      }
      if (!response.ok) {
        const detailCode = body?.detail?.code || body?.detail?.status || body?.code;
        const safeCode = typeof detailCode === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(detailCode) ? detailCode : "unreported";
        logger.warn?.(`[ElevenLabs] operation=${endpoint === "/voices/add" ? "clone" : "speech"} status=${response.status} code=${safeCode}`);
        const error = providerError(response.status, body);
        if (endpoint === "/voices/add" && error.code === "bad_request") {
          throw new VoiceServiceError("The voice service rejected this voice setup. Try a WAV or MP3 recording, and ask the app owner to check the voice account if it continues.", "clone_request_rejected", 400);
        }
        throw error;
      }
      return body;
    } catch (error) {
      if (controller.signal.aborted) throw new VoiceServiceError("The voice service took too long. Please try again.", "timeout", 504);
      if (error instanceof VoiceServiceError) throw error;
      // Exceptions may contain URLs or headers. No retry of paid requests.
      throw new VoiceServiceError("The server could not reach ElevenLabs.", "provider_network_error", 502);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async clone(files, name) {
      if (!files?.length || files.some((file) => !file.size)) {
        throw new VoiceServiceError("Record or upload an audio sample first.", "invalid_audio", 400);
      }
      if (files.reduce((sum, file) => sum + file.size, 0) > MAX_AUDIO_TOTAL_BYTES) {
        throw new VoiceServiceError("Combined recordings must be smaller than 40 MB.", "payload_too_large", 413);
      }
      const cleanName = typeof name === "string" ? name.trim().slice(0, 80) : "";
      const form = new FormData();
      form.append("name", `EchoVoice: ${cleanName || "My Voice"}`);
      // Isolation can damage a clean recording. Capture quality is checked in
      // the browser; preserve the accepted sample's original characteristics.
      form.append("remove_background_noise", "false");
      for (const file of files) {
        form.append("files", new Blob([file.buffer], { type: file.mimetype }), file.originalname || "sample.webm");
      }
      const result = await request("/voices/add", { method: "POST", body: form }, cloneTimeoutMs);
      if (typeof result?.voice_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(result.voice_id)) {
        throw new VoiceServiceError("The voice service did not return a voice profile.", "server_error");
      }
      return { voiceId: result.voice_id, requiresVerification: result.requires_verification === true };
    },
    async synthesize(input) {
      const { voiceId, model, resolvedSettings, requestBody } = validateSpeechInput(input);
      const result = await request(`/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      }, speechTimeoutMs);
      if (typeof result?.audio_base64 !== "string" || !result.audio_base64) {
        throw new VoiceServiceError("The voice service returned no audio.", "server_error");
      }
      return {
        audioBase64: result.audio_base64,
        mimeType: "audio/mpeg",
        alignment: result.alignment || result.normalized_alignment || null,
        modelUsed: model,
        voiceSettingsUsed: resolvedSettings,
      };
    },
  };
}
