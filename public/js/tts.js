// Voice setup, auditions, and generation talk only to EchoVoice's server.
// The server stores raw Omni references and retains ElevenLabs cloning for
// operator switchback. Provider credentials never belong in browser code.

import { logAudio } from "./audioLog.js";

// Save a reference (or create an ElevenLabs clone) only when the sample actually
// changes (a new Blob object = a new recording), not on every single generate.
let cachedSampleBlob = null;
let cachedVoiceId = null;
let cachedVoiceProfileId = null;

// ElevenLabs returns CHARACTER-level timing, not word-level. pitchViz.js groups
// these into words itself. Stashed here (rather than returned from
// synthesizeSpeech) so callers that don't care about it aren't forced to thread
// it through; read it with getLastAlignment().
let lastAlignment = null;

export function getLastAlignment() {
  return lastAlignment;
}

// Carries a short machine-readable `code` alongside the message, so app.js can
// branch on error TYPE (e.g. self-heal on "voice_not_found") without ever having
// to pattern-match on message text — and so every catch site has a `.code` to
// key a safe, pre-written user-facing message off of, never raw error text.
export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ApiError";
    this.code = code || "unknown";
  }
}

// Cloning a clean 1–2 minute recording can exceed the old 30-second deadline.
// Keep these slightly above the server deadlines, including response parsing.
const CLONE_TIMEOUT_MS = 190_000;
const SPEECH_TIMEOUT_MS = 130_000;

async function requestJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    let body;
    try {
      body = await res.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new ApiError("Unexpected response from server.", "network_error");
    }
    if (!res.ok) {
      const error = new ApiError(body?.error || "The request failed.", body?.errorCode || body?.code);
      error.backupAvailable = body?.backupAvailable === true;
      error.backupUrl = typeof body?.backupUrl === "string" ? body.backupUrl : null;
      throw error;
    }
    if (!body || typeof body !== "object") throw new ApiError("Unexpected response from server.", "network_error");
    return body;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ApiError(`Request timed out after ${timeoutMs / 1000}s.`, "timeout");
    }
    if (err instanceof ApiError) throw err;
    // Anything else here is a browser-level network failure (server unreachable,
    // DNS, offline, etc.) — never surface err.message from this raw, it can be
    // an opaque browser string like "Failed to fetch".
    throw new ApiError("Network request failed.", "network_error");
  } finally {
    clearTimeout(timer);
  }
}

// The uploaded filename's extension must match the blob's actual encoding or
// the backend's audio decoder fails. Recorded blobs are usually webm (Chrome/
// Firefox) or mp4 (Safari), and voiceCapture.js preserves the raw recording.
// Its "Upload audio" option also accepts arbitrary
// user-picked audio/video files (mp3, m4a, mov, ...), so this needs to cover
// more than just what our own recorder produces.
function extensionForMimeType(mimeType) {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("flac")) return "flac";
  if (mimeType.includes("quicktime")) return "mov";
  if (mimeType.includes("webm")) return "webm";
  return "webm"; // last-resort default (MediaRecorder's own most common output)
}

// Accepts one or more recordings — ElevenLabs' /v1/voices/add takes multiple
// files in one request and clones from all of them together.
async function cloneVoice(referenceAudioBlobs, name, transcript = "") {
  if (!referenceAudioBlobs.length || referenceAudioBlobs.length > 4 || referenceAudioBlobs.some((blob) => !(blob instanceof Blob) || !blob.size)) {
    throw new ApiError("Use between one and four audio recordings.", "invalid_audio");
  }
  if (referenceAudioBlobs.some((blob) => blob.size > 25 * 1024 * 1024) || referenceAudioBlobs.reduce((total, blob) => total + blob.size, 0) > 40 * 1024 * 1024) {
    throw new ApiError("Audio recordings are too large.", "payload_too_large");
  }
  const formData = new FormData();
  if (name) formData.append("name", name);
  if (transcript) formData.append("transcript", transcript);
  referenceAudioBlobs.forEach((blob, i) => {
    const originalExtension = typeof blob.name === 'string' ? blob.name.match(/\.(mp3|wav|m4a|mp4|webm|ogg|flac|aac|mov)$/i)?.[1] : null;
    formData.append("audio", blob, `sample-${i + 1}.${originalExtension || extensionForMimeType(blob.type || "")}`);
  });

  const body = await requestJson("/api/clone-voice", { method: "POST", body: formData }, CLONE_TIMEOUT_MS);
  if (typeof body.voiceId !== "string" || !body.voiceId) throw new ApiError("No voice profile was returned.", "server_error");
  if (body.requiresVerification) {
    const error = new ApiError("Verify this voice in ElevenLabs before using it.", "verification_required");
    error.voiceId = body.voiceId;
    throw error;
  }
  cachedVoiceProfileId = typeof body.voiceProfileId === "string" ? body.voiceProfileId : null;
  return body.voiceId;
}

/**
 * Explicitly create (or replace) the voice profile from the Initial Capture
 * recording (voiceCapture.js's Stage 1). Call this once that recording is
 * confirmed, BEFORE the user reaches Generate. Cache the returned voice handle
 * and private reference ID; Omni profiles do not create an ElevenLabs clone.
 * @param {Blob|Blob[]} blob - one or more clean voice samples
 * @param {string} [name] - user-chosen voice name
 * @returns {Promise<string>} the new voice handle
 */
export async function createVoiceProfile(blob, name, transcript = "") {
  const recordings = Array.isArray(blob) ? blob : [blob];
  const voiceId = await cloneVoice(recordings, name, transcript);
  cachedSampleBlob = recordings.length === 1 ? recordings[0] : null;
  cachedVoiceId = voiceId;
  return voiceId;
}

export function getCurrentVoiceProfileId() {
  return cachedVoiceProfileId;
}

export async function previewVoice(text, { voiceId, voiceProfileId, languageCode } = {}) {
  if (typeof text !== "string" || !text.trim()) throw new ApiError("Preview text is empty.", "no_text");
  const body = await requestJson("/api/preview-voice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.trim(), voiceId, voiceProfileId, languageCode }),
  }, SPEECH_TIMEOUT_MS);
  if (typeof body.audioBase64 !== "string" || !body.audioBase64 || typeof body.mimeType !== "string" || !body.mimeType.startsWith("audio/")) {
    throw new ApiError("The server returned no usable preview audio.", "server_error");
  }
  return { url: base64ToObjectUrl(body.audioBase64, body.mimeType, null), alignment: body.alignment || null };
}

async function requestSpeech(voiceId, text, { languageCode, modelId, voiceSettings } = {}) {
  const body = await requestJson("/api/synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voiceId, text, languageCode, modelId, voiceSettings }),
  }, SPEECH_TIMEOUT_MS);
  if (typeof body.audioBase64 !== "string" || !body.audioBase64 || body.mimeType !== "audio/mpeg") {
    throw new ApiError("The server returned no usable speech audio.", "server_error");
  }

  return body; // { audioBase64, mimeType, alignment, modelUsed, voiceSettingsUsed }
}

function base64ToObjectUrl(base64, mimeType, logType = "tts-generated") {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    if (logType) logAudio(blob, logType); // fire-and-forget — see audioLog.js
    return URL.createObjectURL(blob);
  } catch {
    throw new ApiError("Received an unusable audio response.", "unknown");
  }
}

export async function planIdealDelivery(script, mode) {
  if (typeof script !== "string" || !script.trim()) throw new ApiError("Script text is empty.", "no_text");
  return requestJson("/api/plan-delivery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script: script.trim(), mode }),
  }, SPEECH_TIMEOUT_MS);
}

export async function generateIdealSpeech({ script, mode, plannerId, voiceId, voiceProfileId, languageCode, modelId, voiceSettings }) {
  const body = await requestJson("/api/generate-ideal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script, mode, plannerId, voiceId, voiceProfileId, languageCode, modelId, voiceSettings }),
  }, SPEECH_TIMEOUT_MS);
  if (typeof body.audioBase64 !== "string" || !body.audioBase64 || typeof body.mimeType !== "string" || !body.mimeType.startsWith("audio/")) {
    throw new ApiError("The server returned no usable speech audio.", "server_error");
  }
  lastAlignment = body.alignment || null;
  return { url: base64ToObjectUrl(body.audioBase64, body.mimeType, null), alignment: lastAlignment };
}

/**
 * Generate speech in the cloned voice.
 *
 * In the normal app flow, cloning already happened explicitly via
 * createVoiceProfile() (the two-stage recording flow) before this is ever
 * called, so app.js calls this with referenceAudioBlob = null and relies on
 * priority #2/#3 below. Priority #1 (single-blob auto-clone) is kept working
 * for robustness/reuse but isn't exercised by the current UI.
 *
 * Which voice_id gets used, in priority order:
 *   1. referenceAudioBlob, if it's a NEW recording (different from whatever we
 *      last cloned) — this is the explicit "make a fresh clone" signal, and it
 *      always wins even if a fallbackVoiceId is also set.
 *   2. options.fallbackVoiceId — a voice_id typed/pasted into the UI, or the one
 *      createVoiceProfile() just cached (app.js writes it into the same field).
 *      No cloning happens in this case; it's used as-is.
 *   3. Whatever voice_id we cloned earlier THIS page session, if any.
 *   4. Otherwise: throws, since there's nothing to generate with.
 *
 * @param {string} text - what to say
 * @param {Blob|null} referenceAudioBlob - the recorded voice sample, or null if
 *   relying on fallbackVoiceId instead
 * @param {object} [options]
 * @param {string} [options.languageCode] - ISO 639-1 code (e.g. "es", "fr") to force
 *   that language; omit/empty for auto-detect from the text. NOTE: this only
 *   controls which LANGUAGE is spoken. There's no separate "accent" control — for
 *   a cloned voice, accent comes from the reference recording, not a request param.
 * @param {string} [options.modelId] - which ElevenLabs model to generate with (e.g.
 *   "eleven_flash_v2_5", "eleven_multilingual_v2", "eleven_v3"); server.js
 *   defaults and validates this against an allowlist if omitted/unrecognized.
 * @param {{stability?:number, similarity_boost?:number, style?:number}} [options.voiceSettings]
 * @param {string} [options.fallbackVoiceId] - an existing ElevenLabs voice_id to use
 *   when there's no new recording to clone (see priority order above).
 * @returns {Promise<{url: string, voiceId: string, modelUsed: string}>}
 */
export async function synthesizeSpeech(text, referenceAudioBlob, options = {}) {
  if (typeof text !== "string" || !text.trim()) throw new ApiError("Script text is empty.", "no_text");

  let voiceId;
  if (referenceAudioBlob && referenceAudioBlob !== cachedSampleBlob) {
    voiceId = await cloneVoice([referenceAudioBlob]);
    cachedSampleBlob = referenceAudioBlob;
    cachedVoiceId = voiceId;
  } else if (options.fallbackVoiceId) {
    voiceId = options.fallbackVoiceId;
  } else if (cachedVoiceId) {
    voiceId = cachedVoiceId;
  } else {
    throw new ApiError("No voice available.", "no_voice");
  }

  const result = await requestSpeech(voiceId, text.trim(), options);
  lastAlignment = result.alignment;

  return {
    url: base64ToObjectUrl(result.audioBase64, result.mimeType),
    voiceId,
    modelUsed: result.modelUsed,
  };
}
