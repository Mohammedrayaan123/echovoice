// tts.js — the ONLY file that talks to the TTS/voice-cloning backend.
//
// PHASE 1 (done): Chatterbox, called directly from the browser.
// PHASE 2 (now): ElevenLabs. The browser NEVER talks to ElevenLabs directly — the
// API key can't be trusted in client-side code, so this file calls OUR OWN server
// (server.js), which holds the key and proxies the real requests. See server.js
// for the /api/clone-voice and /api/synthesize endpoints.

import { logAudio } from "./audioLog.js";

// Voice cloning is comparatively slow and ElevenLabs plans cap how many custom
// voices you can have, so we only re-clone when the recorded sample actually
// changes (a new Blob object = a new recording), not on every single generate.
let cachedSampleBlob = null;
let cachedVoiceId = null;

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

// Without this, a slow/hung network or a stalled ElevenLabs response leaves the
// Generate button disabled and the status text stuck on "Generating speech..."
// forever, with no way to recover short of reloading the page.
const REQUEST_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new ApiError(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`, "timeout");
    }
    // Anything else here is a browser-level network failure (server unreachable,
    // DNS, offline, etc.) — never surface err.message from this raw, it can be
    // an opaque browser string like "Failed to fetch".
    throw new ApiError("Network request failed.", "network_error");
  } finally {
    clearTimeout(timer);
  }
}

// Parses a fetch Response as JSON, mapping a malformed/unexpected response
// (e.g. the server crashed and returned an HTML error page) to a safe ApiError
// instead of letting a raw JSON.parse SyntaxError escape to the UI.
async function parseJsonResponse(res) {
  try {
    return await res.json();
  } catch {
    throw new ApiError("Unexpected response from server.", "network_error");
  }
}

// The uploaded filename's extension must match the blob's actual encoding or
// the backend's audio decoder fails. Recorded blobs are usually webm (Chrome/
// Firefox) or mp4 (Safari), and voiceCapture.js's noise gate re-encodes to WAV
// — but voiceCapture.js's "Upload audio" option also accepts arbitrary
// user-picked audio/video files (mp3, m4a, mov, ...), so this needs to cover
// more than just what our own recorder/noise-gate produce.
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
// files in one request and clones from all of them together. The current UI
// (voiceCapture.js) only ever sends one (the Initial Capture sample), but this
// stays generic since the old single-blob auto-clone path below reuses it too.
async function cloneVoice(referenceAudioBlobs, name) {
  const formData = new FormData();
  if (name) formData.append("name", name);
  referenceAudioBlobs.forEach((blob, i) => {
    formData.append("audio", blob, `sample-${i + 1}.${extensionForMimeType(blob.type || "")}`);
  });

  const res = await fetchWithTimeout("/api/clone-voice", { method: "POST", body: formData });
  const body = await parseJsonResponse(res);
  if (!res.ok) throw new ApiError(body.error || "Voice cloning failed.", body.errorCode);

  return body.voiceId;
}

/**
 * Explicitly create (or replace) the voice profile from the Initial Capture
 * recording (voiceCapture.js's Stage 1). Call this once that recording is
 * confirmed, BEFORE the user reaches Generate — the resulting voice_id is
 * cached here, so synthesizeSpeech(text, null, ...) will pick it up
 * automatically afterward without needing a blob passed to it.
 * @param {Blob} blob - the Initial Capture sample (optionally noise-gated)
 * @param {string} [name] - user-chosen voice name
 * @returns {Promise<string>} the new voice_id
 */
export async function createVoiceProfile(blob, name) {
  const voiceId = await cloneVoice([blob], name);
  cachedVoiceId = voiceId;
  return voiceId;
}

async function requestSpeech(voiceId, text, { languageCode, modelId, voiceSettings } = {}) {
  const res = await fetchWithTimeout("/api/synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voiceId, text, languageCode, modelId, voiceSettings }),
  });
  const body = await parseJsonResponse(res);
  if (!res.ok) throw new ApiError(body.error || "Speech generation failed.", body.errorCode);

  return body; // { audioBase64, mimeType, alignment, modelUsed, voiceSettingsUsed }
}

function base64ToObjectUrl(base64, mimeType) {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    logAudio(blob, "tts-generated"); // fire-and-forget — see audioLog.js
    return URL.createObjectURL(blob);
  } catch {
    throw new ApiError("Received an unusable audio response.", "unknown");
  }
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
  if (!text?.trim()) throw new ApiError("Script text is empty.", "no_text");

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
