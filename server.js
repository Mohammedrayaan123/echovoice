// server.js — serves the app AND proxies calls to ElevenLabs.
//
// Why this exists: the browser can never be trusted with the ElevenLabs API key
// (anyone could read it out of page source / dev tools). So the key lives only
// here, in .env, and the browser talks to these two endpoints instead of talking
// to ElevenLabs directly. Only files inside public/ are ever served over HTTP —
// this file, package.json, .env, and node_modules are not reachable from a browser.

// Must run before any other import — ES module imports are all evaluated
// before the rest of this file's own top-level code, so a later `import
// supabase from "./supabaseClient.js"` would otherwise read process.env
// BEFORE dotenv has loaded .env into it, always seeing undefined regardless
// of what's actually in the file. The side-effect-only "dotenv/config" entry
// point runs dotenv.config() as part of ITS OWN evaluation, and sibling
// imports evaluate in source order, so putting this first guarantees env
// vars are populated before supabaseClient.js (or anything else) reads them.
import "dotenv/config";

import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";
import supabase from "./supabaseClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

// Every env var the app reads, and what happens if it's missing — logged
// once at startup so a misconfigured deploy is obvious in the logs instead
// of surfacing later as a confusing per-request failure. Nothing here is
// fatal: every one of these already degrades gracefully at its call site
// (voice cloning/TTS return a friendly "not configured" error; audio
// logging silently skips the remote upload) — this is a startup checklist,
// not a hard requirement, since e.g. Supabase logging is optional.
const ENV_VAR_INFO = [
  { name: "ELEVENLABS_API_KEY", impact: "voice cloning and speech generation will fail on every request" },
  { name: "SUPABASE_URL", impact: "remote audio logging will be skipped (local-dev copy still works)" },
  { name: "SUPABASE_SECRET_KEY", impact: "remote audio logging will be skipped (local-dev copy still works)" },
];

function checkRequiredEnvVars() {
  const missing = ENV_VAR_INFO.filter(({ name }) => !process.env[name]);
  if (missing.length === 0) return;
  console.warn("Missing environment variable(s):");
  for (const { name, impact } of missing) {
    console.warn(`  - ${name}: ${impact}`);
  }
}

// eleven_multilingual_v2 (not eleven_flash_v2_5) — higher-fidelity voice cloning;
// flash trades clone accuracy for speed, which was making generations sound less
// like the user's real voice than the ElevenLabs Playground. Tradeoff: v2 does
// NOT honor the `language_code` parameter (only turbo_v2_5/flash_v2_5 do), so the
// Language dropdown's forcing has no effect on this default — it auto-detects
// language from the text instead. Flash is still selectable per-generation via
// the Model dropdown when speed or language-forcing matters more than accuracy.
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";

// Only these may be requested — never forward an arbitrary client-supplied string
// straight into the ElevenLabs request. All three verified (2026-09) to work with
// Instant Voice Clone voices and return the same alignment shape pitchViz.js needs.
const ALLOWED_MODEL_IDS = new Set(["eleven_flash_v2_5", "eleven_multilingual_v2", "eleven_v3"]);

// Sent explicitly on every request rather than relying on ElevenLabs' own default
// for the voice — the Playground applies whatever settings are saved against the
// voice, which may not match what a bare API call gets. similarity_boost maxed
// and style zeroed to prioritize sounding like the user's actual voice over
// stylistic exaggeration; use_speaker_boost enhances similarity to the original
// speaker and was previously not being sent at all. All tunable from the UI
// (except use_speaker_boost, which isn't exposed as a control — see below).
const DEFAULT_VOICE_SETTINGS = { stability: 0.5, similarity_boost: 1.0, style: 0.0, use_speaker_boost: true };

// Explicit rather than relying on ElevenLabs' own default (which happens to match
// this today, but "explicit" means it can't silently drift if that default changes).
const OUTPUT_FORMAT = "mp3_44100_128";

function clamp01(n, fallback) {
  const num = Number(n);
  return Number.isFinite(num) ? Math.min(1, Math.max(0, num)) : fallback;
}

// Classifies a failed ElevenLabs response into a small set of known error codes
// with a short, SAFE-TO-SHOW summary — the raw ElevenLabs error body (which can
// contain implementation details) is logged server-side for debugging but NEVER
// included in what gets sent back to the browser. This is the one place that
// decides what "kind" of failure this was; app.js maps codes to the actual
// user-facing copy (including demo-day guidance like "try a backup clip").
function classifyElevenLabsError(status, rawBody) {
  let detailCode = null;
  try {
    detailCode = JSON.parse(rawBody)?.detail?.code || null;
  } catch {
    // rawBody wasn't JSON (e.g. an HTML error page from an upstream proxy) — fall
    // through to status-based classification below.
  }

  let code = "unknown";
  if (detailCode === "voice_not_found") code = "voice_not_found";
  else if (status === 404) code = "voice_not_found";
  else if (status === 429) code = "rate_limited";
  else if (status === 401 || status === 403) code = "auth_error";
  else if (status >= 500) code = "server_error";

  const summaries = {
    voice_not_found: "Voice not found.",
    rate_limited: "Rate limited by the voice service.",
    auth_error: "Voice service authentication failed.",
    server_error: "Voice service is having issues.",
    unknown: "Voice service request failed.",
  };

  return { code, error: summaries[code] };
}

// Without this, a stalled ElevenLabs response hangs this request indefinitely,
// which in turn leaves the browser's own fetch hanging too — the button gets
// stuck disabled with no error ever surfacing. Shorter than the client's own
// 30s timeout so the server fails first and returns a clear error instead of
// the client's generic network-timeout message.
const ELEVENLABS_TIMEOUT_MS = 25_000;

async function fetchElevenLabs(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`ElevenLabs didn't respond within ${ELEVENLABS_TIMEOUT_MS / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

app.use(express.json());

// This app is under active development — a stale cached JS/HTML file in the
// browser can cause confusing bugs (e.g. a page still running an old script that
// imports a function name that no longer exists, silently breaking every button).
// Disabling caching entirely trades a little load speed for "what you see is
// always what's on disk," which matters more while iterating toward a demo.
// (Must set the header BEFORE express.static — it ends the response itself for
// any file it finds, so middleware placed after it never runs for those requests.)
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.static(path.join(__dirname, "public"), { etag: false, lastModified: false, cacheControl: false }));

// Used by Render (and anyone else) to confirm the service is up and
// responding — deliberately has no dependency on ElevenLabs/Supabase being
// configured, so it reflects "the server process is alive," not "every
// integration is working."
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Tracks the one cloned voice this server process is using. ElevenLabs plans cap
// how many custom voices you can have, and this is a rehearsal tool where the user
// hits "Generate" many times per recording — so we clone once per recording and
// reuse the voice_id, instead of cloning a new voice on every request.
let currentVoiceId = null;

// "EchoVoice sample " is the old auto-generated-name format (pre voiceCapture.js);
// "EchoVoice: " prefixes every voice created since (the user's chosen name comes
// after it). Checking both means old test voices from before this change still
// get swept, not just new ones.
const OWN_VOICE_NAME_PREFIXES = ["EchoVoice sample ", "EchoVoice: "];

function isOwnVoiceName(name) {
  return typeof name === "string" && OWN_VOICE_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// Only ever deletes a voice if its name matches OUR naming convention — refuses
// to delete anything else (a user's own playground voice, a premade voice, etc.),
// even if called with a wrong/stale id due to some future bug.
async function deleteIfOwnedByUs(voiceId) {
  const res = await fetchElevenLabs(`${ELEVENLABS_BASE}/voices/${voiceId}`, {
    headers: { "xi-api-key": ELEVENLABS_API_KEY },
  });
  if (!res.ok) return;

  const voice = await res.json();
  if (!isOwnVoiceName(voice.name)) return;

  await fetchElevenLabs(`${ELEVENLABS_BASE}/voices/${voiceId}`, {
    method: "DELETE",
    headers: { "xi-api-key": ELEVENLABS_API_KEY },
  });
}

// upload.array (not upload.single) — ElevenLabs' /v1/voices/add accepts multiple
// "files" parts in a single clone call; kept generic even though voiceCapture.js
// currently only ever sends one recording. Capped at 4 to bound upload size.
app.post("/api/clone-voice", upload.array("audio", 4), async (req, res) => {
  if (!ELEVENLABS_API_KEY) {
    console.error("ELEVENLABS_API_KEY is not set in .env.");
    return res.status(500).json({ error: "Voice generation isn't configured.", errorCode: "not_configured" });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No audio file(s) received.", errorCode: "bad_request" });
  }

  try {
    // req.body.name is the user-chosen name from voiceCapture.js's naming step.
    // Kept under our own prefix (see isOwnVoiceName) so the restart-cleanup sweep
    // still recognizes and can safely delete it later — an arbitrary user name
    // with no prefix would silently escape cleanup and pile up toward the
    // account's voice-slot cap.
    const rawName = (req.body.name || "").toString().trim();
    const voiceName = `EchoVoice: ${rawName.slice(0, 100) || "My Voice"}`;

    const form = new FormData();
    form.append("name", voiceName);
    for (const file of req.files) {
      form.append("files", new Blob([file.buffer], { type: file.mimetype }), file.originalname || "sample.webm");
    }

    const elevenRes = await fetchElevenLabs(`${ELEVENLABS_BASE}/voices/add`, {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
      body: form,
    });

    if (!elevenRes.ok) {
      const detail = await elevenRes.text();
      console.error(`Voice cloning failed (${elevenRes.status}):`, detail); // raw detail: server log only
      const { code, error } = classifyElevenLabsError(elevenRes.status, detail);
      return res.status(elevenRes.status).json({ error, errorCode: code });
    }

    const { voice_id: voiceId } = await elevenRes.json();
    const previousVoiceId = currentVoiceId;
    currentVoiceId = voiceId;

    // Best-effort cleanup of the old clone so voice slots don't pile up. Not
    // awaited/blocking — the user doesn't need to wait on this to keep going.
    // Belt-and-suspenders: currentVoiceId should only ever hold voice_ids WE
    // created (the "paste your own voice_id" flow never touches this endpoint
    // or this variable), but we double-check the name prefix before deleting
    // anyway — this is the one place a bug here could delete a real voice from
    // the user's account, so it's worth the extra request.
    if (previousVoiceId && previousVoiceId !== voiceId) {
      deleteIfOwnedByUs(previousVoiceId).catch(() => {});
    }

    res.json({ voiceId });
  } catch (err) {
    console.error("Voice cloning request failed:", err); // full error: server log only
    const code = err.message?.includes("didn't respond within") ? "timeout" : "network_error";
    res.status(500).json({ error: "Voice cloning request failed.", errorCode: code });
  }
});

app.post("/api/synthesize", async (req, res) => {
  if (!ELEVENLABS_API_KEY) {
    console.error("ELEVENLABS_API_KEY is not set in .env.");
    return res.status(500).json({ error: "Voice generation isn't configured.", errorCode: "not_configured" });
  }

  const { voiceId, text, languageCode, modelId, voiceSettings } = req.body;
  if (!voiceId || !text) {
    return res.status(400).json({ error: "voiceId and text are both required.", errorCode: "bad_request" });
  }

  try {
    const model = ALLOWED_MODEL_IDS.has(modelId) ? modelId : DEFAULT_MODEL_ID;
    const resolvedVoiceSettings = {
      stability: clamp01(voiceSettings?.stability, DEFAULT_VOICE_SETTINGS.stability),
      similarity_boost: clamp01(voiceSettings?.similarity_boost, DEFAULT_VOICE_SETTINGS.similarity_boost),
      style: clamp01(voiceSettings?.style, DEFAULT_VOICE_SETTINGS.style),
      // Not exposed as a UI control (no slider for a boolean) — always on, per request.
      use_speaker_boost: DEFAULT_VOICE_SETTINGS.use_speaker_boost,
    };
    const requestBody = { text, model_id: model, voice_settings: resolvedVoiceSettings };
    // Omit language_code entirely for "auto-detect" — sending an empty string
    // would ask ElevenLabs to enforce "no language," which isn't what we want.
    if (languageCode) requestBody.language_code = languageCode;

    const elevenRes = await fetchElevenLabs(
      `${ELEVENLABS_BASE}/text-to-speech/${voiceId}/with-timestamps?output_format=${OUTPUT_FORMAT}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!elevenRes.ok) {
      const detail = await elevenRes.text();
      console.error(`Speech generation failed (${elevenRes.status}):`, detail); // raw detail: server log only
      const { code, error } = classifyElevenLabsError(elevenRes.status, detail);
      return res.status(elevenRes.status).json({ error, errorCode: code });
    }

    // alignment is CHARACTER-level timing (characters[], character_start/end_times_seconds[]).
    // Grouping characters into word-level cues is Phase 2 pitch-viz work, not done here.
    const { audio_base64: audioBase64, alignment } = await elevenRes.json();
    res.json({
      audioBase64,
      mimeType: "audio/mpeg",
      alignment,
      modelUsed: model,
      voiceSettingsUsed: resolvedVoiceSettings,
    });
  } catch (err) {
    console.error("Speech generation request failed:", err); // full error: server log only
    const code = err.message?.includes("didn't respond within") ? "timeout" : "network_error";
    res.status(500).json({ error: "Speech generation request failed.", errorCode: code });
  }
});

// ---------- Audio logging (Supabase Storage + local dev copy) ----------
//
// Every audio blob that passes through the app (raw recordings, the guided
// verification reading, TTS output, and later the comparison attempt) gets
// POSTed here so it's accessible remotely — the teammate testing against the
// hosted Render deployment produces samples that would otherwise only ever
// exist in his browser's memory. This is a logging side-channel, not part of
// the product flow: every failure here is caught and logged server-side,
// never thrown, so a Supabase outage can't affect voice cloning or playback.

const AUDIO_LOG_TYPES = new Set(["recording", "guided", "tts-generated", "user-attempt"]);
const AUDIO_LOG_DIR = path.join(__dirname, "audio-logs");

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

function extensionForAudioMimeType(mimetype) {
  if (!mimetype) return "webm";
  if (mimetype.includes("webm")) return "webm";
  if (mimetype.includes("mpeg") || mimetype.includes("mp3")) return "mp3";
  if (mimetype.includes("mp4")) return "mp4";
  if (mimetype.includes("wav")) return "wav";
  if (mimetype.includes("ogg")) return "ogg";
  return "webm"; // MediaRecorder's own most common output
}

app.post("/save-audio", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "No audio file received." });
  }

  // Whitelisted rather than trusting the client-supplied string outright —
  // it only ever ends up in a filename, but there's no reason not to pin it
  // to the known set.
  const type = AUDIO_LOG_TYPES.has(req.body.type) ? req.body.type : "unknown";
  const filename = `${timestampForFilename(new Date())}_${type}.${extensionForAudioMimeType(req.file.mimetype)}`;

  let url = null;

  if (supabase) {
    try {
      const { error } = await supabase.storage
        .from("audio-logs")
        .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (error) throw error;
      url = supabase.storage.from("audio-logs").getPublicUrl(filename).data.publicUrl;
    } catch (err) {
      console.error("Audio log: Supabase upload failed (non-blocking):", err.message || err);
    }
  } else {
    console.warn("Audio log: SUPABASE_URL/SUPABASE_SECRET_KEY not set — skipping remote upload.");
  }

  if (process.env.NODE_ENV !== "production") {
    try {
      await fs.mkdir(AUDIO_LOG_DIR, { recursive: true });
      await fs.writeFile(path.join(AUDIO_LOG_DIR, filename), req.file.buffer);
    } catch (err) {
      console.error("Audio log: local save failed (non-blocking):", err.message || err);
    }
  }

  res.json({ ok: true, url });
});

// currentVoiceId only lives in this process's memory, so every server restart
// "forgets" which clone to delete before making a new one — over many restarts
// during development, orphaned "EchoVoice sample ..." voices pile up toward the
// account's voice-slot limit. The client always re-clones after a restart anyway
// (its own cached blob/voiceId are page-local state, gone on reload), so there's
// no reason to keep old clones around — sweep them on boot. Only ever touches
// voices with OUR exact naming prefix; never premade voices or anything named
// something else, like a manually-created "My voice".
async function cleanupOrphanedVoices() {
  if (!ELEVENLABS_API_KEY) return;

  try {
    const res = await fetchElevenLabs(`${ELEVENLABS_BASE}/voices`, {
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
    });
    if (!res.ok) return;

    const { voices } = await res.json();
    const orphaned = voices.filter((v) => isOwnVoiceName(v.name));

    await Promise.all(orphaned.map((v) => deleteIfOwnedByUs(v.voice_id).catch(() => {})));

    if (orphaned.length > 0) {
      console.log(`Cleaned up ${orphaned.length} orphaned voice(s) from previous runs.`);
    }
  } catch {
    // Non-critical — worst case, old clones linger until the next successful boot.
  }
}

const PORT = process.env.PORT || 5500;
app.listen(PORT, () => {
  console.log(`EchoVoice running on port ${PORT}`);
  checkRequiredEnvVars();
  cleanupOrphanedVoices();
});
