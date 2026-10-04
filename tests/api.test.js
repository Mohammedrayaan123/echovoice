import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server.js";
import { VoiceServiceError } from "../server/voiceService.js";
import { loadConfig } from "../server/config.js";

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const audioResult = { audio_base64: "YXVkaW8=", alignment: null };

async function serve(t, options = {}) {
  const server = createApp({ apiKey: "test-only", runtimeConfig: loadConfig({}), saveLocalAudio: false, supabaseClient: null, logger: { warn() {}, error() {} }, ...options }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function recording(name = "My Voice", count = 1) {
  const form = new FormData();
  form.append("name", name);
  for (let i = 0; i < count; i++) form.append("audio", new Blob(["audio sample"], { type: "audio/webm" }), `sample-${i}.webm`);
  return form;
}

test("new visitors and server restarts retain previous voice profiles", async (t) => {
  const calls = [];
  let clones = 0;
  const provider = async (url, options) => {
    calls.push({ url, method: options.method });
    if (url.endsWith("/voices/add")) return jsonResponse({ voice_id: `voice_${++clones}`, requires_verification: false });
    return jsonResponse(audioResult);
  };
  const runtimeConfig = loadConfig({ IDEAL_VOICE_PROVIDER: "elevenlabs" });
  const firstServer = await serve(t, { runtimeConfig, fetchImpl: provider });
  assert.equal(calls.length, 0, "startup must not inspect or delete account voices");
  const first = await (await fetch(`${firstServer}/api/clone-voice`, { method: "POST", body: recording("First friend") })).json();
  const second = await (await fetch(`${firstServer}/api/clone-voice`, { method: "POST", body: recording("Second friend") })).json();
  assert.notEqual(first.voiceId, second.voiceId);
  const restartedServer = await serve(t, { runtimeConfig, fetchImpl: provider });
  const speech = await fetch(`${restartedServer}/api/synthesize`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voiceId: first.voiceId, text: "My original voice still works." }),
  });
  assert.equal(speech.status, 200);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ method }) => method === "POST"));
  assert.match(calls[2].url, /voice_1\/with-timestamps/);
});

test("all accepted recordings reach cloning intact and verification is reported", async (t) => {
  let submitted;
  const base = await serve(t, { runtimeConfig: loadConfig({ IDEAL_VOICE_PROVIDER: "elevenlabs" }), fetchImpl: async (url, options) => {
    submitted = options.body;
    return jsonResponse({ voice_id: "new_voice", requires_verification: true });
  } });
  const response = await fetch(`${base}/api/clone-voice`, { method: "POST", body: recording("Alex", 2) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { voiceId: "new_voice", requiresVerification: true });
  assert.equal(submitted.getAll("files").length, 2);
  assert.equal(await submitted.getAll("files")[0].text(), "audio sample");
  assert.equal(submitted.get("remove_background_noise"), "false");
});

test("voice setup retains the raw sample and exact transcript for Omni", async (t) => {
  let stored;
  let providerCalls = 0;
  const profileStore = { save: async (value) => { stored = value; return "profile_123"; } };
  const base = await serve(t, {
    profileStore,
    apiKey: "",
    fetchImpl: async () => { providerCalls++; return jsonResponse({ detail: { status: "bad_request" } }, 400); },
  });
  const form = recording("Taylor");
  form.append("transcript", "These are the exact words in my sample.");
  const response = await fetch(`${base}/api/clone-voice`, { method: "POST", body: form });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.voiceId, /^local_[0-9a-f-]{36}$/);
  assert.equal(body.voiceProfileId, "profile_123");
  assert.equal(body.requiresVerification, false);
  assert.equal(stored.transcript, "These are the exact words in my sample.");
  assert.equal(stored.voiceId, body.voiceId);
  assert.equal(stored.file.buffer.toString(), "audio sample");
  assert.equal(providerCalls, 0, "Omni setup must not require ElevenLabs cloning permissions or credits");
});

test("Omni setup rejects missing or oversized transcripts and multiple samples before saving", async (t) => {
  let saves = 0;
  let providerCalls = 0;
  const base = await serve(t, {
    profileStore: { save: async () => { saves++; } },
    fetchImpl: async () => { providerCalls++; throw new Error("must not call provider"); },
  });
  const missingTranscript = await fetch(`${base}/api/clone-voice`, { method: "POST", body: recording() });
  assert.equal((await missingTranscript.json()).errorCode, "missing_reference_transcript");
  const longTranscript = recording();
  longTranscript.append("transcript", "a".repeat(3001));
  assert.equal((await (await fetch(`${base}/api/clone-voice`, { method: "POST", body: longTranscript })).json()).errorCode, "text_too_long");
  const multiple = recording("My voice", 2);
  multiple.append("transcript", "Exact words");
  assert.equal((await (await fetch(`${base}/api/clone-voice`, { method: "POST", body: multiple })).json()).errorCode, "invalid_audio");
  assert.equal(saves, 0);
  assert.equal(providerCalls, 0);
});

test("Omni setup, audition, and planned ideal generation share the raw reference without an ElevenLabs clone", async (t) => {
  const profiles = new Map();
  const providerCalls = [];
  const omniCalls = [];
  const base = await serve(t, {
    runtimeConfig: loadConfig({ ELEVENLABS_REFERENCE_VOICE_ID: "stock_reference" }),
    profileStore: {
      save: async (value) => { profiles.set("saved_profile", value); return "saved_profile"; },
      get: async (id) => {
        const saved = profiles.get(id);
        return { voiceId: saved.voiceId, transcript: saved.transcript, audio: saved.file.buffer, mimetype: saved.file.mimetype };
      },
    },
    audioLogger: { log: async () => null },
    fetchImpl: async (url, options) => {
      providerCalls.push({ url, body: options.body });
      assert.match(url, /text-to-speech\/stock_reference\/with-timestamps/);
      return jsonResponse({ ...audioResult, alignment: { character_end_times_seconds: [3] } });
    },
    omniVoiceClient: { generate: async (input) => {
      omniCalls.push(input);
      return { audio: Buffer.from("final cloned audio"), mimeType: "audio/wav" };
    } },
  });
  const form = recording();
  form.append("transcript", "The exact recorded words.");
  const voice = await (await fetch(`${base}/api/clone-voice`, { method: "POST", body: form })).json();
  const request = async (route, body) => fetch(`${base}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const preview = await request("/api/preview-voice", { ...voice, text: "A short audition." });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).mimeType, "audio/wav");
  assert.equal(providerCalls.length, 0, "neutral Omni audition must not spend ElevenLabs planning credits");
  const script = "Practice this exact answer.";
  const plan = await (await request("/api/plan-delivery", { script, mode: "interview" })).json();
  const ideal = await request("/api/generate-ideal", { ...voice, script, mode: "interview", plannerId: plan.plannerId });
  assert.equal(ideal.status, 200);
  const result = await ideal.json();
  assert.equal(Buffer.from(result.audioBase64, "base64").toString(), "final cloned audio");
  assert.equal(result.alignment, null);
  assert.equal(providerCalls.length, 1);
  assert.equal(omniCalls.length, 2);
  assert.deepEqual(omniCalls.map(({ script }) => script), ["A short audition.", script]);
  for (const call of omniCalls) {
    assert.equal(call.referenceAudio.toString(), "audio sample");
    assert.equal(call.referenceTranscript, "The exact recorded words.");
    assert.equal(call.referenceMimeType, "audio/webm");
    assert.equal(call.instruction, "");
    assert.equal(call.targetDuration, null);
  }
});

test("Omni preview validates identity and preserves timeout errors without retrying", async (t) => {
  let calls = 0;
  const base = await serve(t, {
    profileStore: { get: async () => ({ voiceId: "local_voice", transcript: "Exact words", audio: Buffer.from("raw"), mimetype: "audio/wav" }) },
    omniVoiceClient: { generate: async () => { calls++; throw new VoiceServiceError("Voice generation is taking longer than expected.", "OMNI_TIMEOUT", 504); } },
  });
  const preview = async (body) => fetch(`${base}/api/preview-voice`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await (await preview({ text: "Hello" })).json()).errorCode, "missing_voice_sample");
  assert.equal((await (await preview({ text: "Hello", voiceProfileId: "profile", voiceId: "wrong" })).json()).errorCode, "missing_voice_sample");
  assert.equal(calls, 0);
  const failed = await preview({ text: "Hello", voiceProfileId: "profile", voiceId: "local_voice" });
  assert.equal(failed.status, 504);
  assert.equal((await failed.json()).errorCode, "OMNI_TIMEOUT");
  assert.equal(calls, 1);
});

test("ElevenLabs switchback preview keeps the neutral legacy model and audio contract", async (t) => {
  let submitted;
  const base = await serve(t, {
    runtimeConfig: loadConfig({ IDEAL_VOICE_PROVIDER: "elevenlabs" }),
    fetchImpl: async (url, options) => { submitted = { url, body: JSON.parse(options.body) }; return jsonResponse(audioResult); },
    omniVoiceClient: { generate: async () => { throw new Error("must not call Omni"); } },
  });
  const response = await fetch(`${base}/api/preview-voice`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voiceId: "voice_1", text: "Hello", modelId: "eleven_v3" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mimeType, "audio/mpeg");
  assert.equal(submitted.body.model_id, "eleven_multilingual_v2");
  assert.match(submitted.url, /voice_1\/with-timestamps/);
});

test("invalid uploads and JSON are rejected as JSON before contacting the provider", async (t) => {
  let providerCalls = 0;
  const base = await serve(t, { fetchImpl: async () => { providerCalls++; return jsonResponse(audioResult); } });
  const invalid = new FormData();
  invalid.append("audio", new Blob(["bad"], { type: "text/plain" }), "script.txt");
  const upload = await fetch(`${base}/api/clone-voice`, { method: "POST", body: invalid });
  assert.equal(upload.status, 400);
  assert.equal((await upload.json()).errorCode, "invalid_audio");
  const malformed = await fetch(`${base}/api/synthesize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad json" });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).errorCode, "bad_request");
  const empty = await fetch(`${base}/api/clone-voice`, { method: "POST", body: new FormData() });
  assert.equal(empty.status, 400);
  assert.equal(providerCalls, 0);
});

test("request size limits return safe errors instead of an HTML stack trace", async (t) => {
  let providerCalls = 0;
  const base = await serve(t, { fetchImpl: async () => { providerCalls++; return jsonResponse(audioResult); } });
  const tooLarge = await fetch(`${base}/api/synthesize`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "x".repeat(270_000) }),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).errorCode, "payload_too_large");
  const files = new FormData();
  files.append("audio", new Blob([new Uint8Array(25 * 1024 * 1024 + 1)], { type: "audio/wav" }), "large.wav");
  const largeFile = await fetch(`${base}/api/clone-voice`, { method: "POST", body: files });
  assert.equal(largeFile.status, 413);
  assert.equal((await largeFile.json()).errorCode, "payload_too_large");
  assert.equal(providerCalls, 0);
});

test("health remains available without credentials, private files stay private", async (t) => {
  const base = await serve(t, { apiKey: "" });
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: "ok" });
  for (const file of [".env", "server.js", "server/voiceService.js", "package.json"]) {
    assert.equal((await fetch(`${base}/${file}`)).status, 404);
  }
  const speech = await fetch(`${base}/api/synthesize`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voiceId: "my_voice", text: "Hello" }),
  });
  assert.equal(speech.status, 503);
  assert.equal((await speech.json()).errorCode, "not_configured");
});

test("production planning and ideal routes keep provider details behind the server", async (t) => {
  const calls = [];
  const idealGenerationService = {
    plan: async (input) => { calls.push(["plan", input]); return { plannerId: "plan-1", instruction: "calm", targetDuration: 12, targetSpeed: 1, measuredWpm: 125 }; },
    generate: async (input) => { calls.push(["generate", input]); return { success: true, audioBase64: "YXVkaW8=", mimeType: "audio/wav", alignment: null }; },
  };
  const base = await serve(t, { idealGenerationService });
  const studio = await (await fetch(`${base}/api/studio-config`)).json();
  assert.deepEqual(studio.deliveryModes.map(({ id }) => id), ["interview", "presentation", "storytelling", "admissions"]);
  assert.equal(studio.voiceModelControlsEnabled, false);
  assert.equal("idealVoiceProvider" in studio, false);
  assert.equal("omniSpaceId" in studio, false);

  const plan = await (await fetch(`${base}/api/plan-delivery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ script: "Hello", mode: "interview" }) })).json();
  const ideal = await (await fetch(`${base}/api/generate-ideal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plannerId: plan.plannerId, script: "Hello", mode: "interview", voiceId: "voice", voiceProfileId: "profile" }) })).json();
  assert.equal(ideal.mimeType, "audio/wav");
  assert.equal(calls.length, 2);
});

test("generation errors include safe manual backup metadata", async (t) => {
  const idealGenerationService = {
    plan: async () => ({}),
    generate: async () => {
      const error = new VoiceServiceError("Voice generation is taking longer than expected.", "OMNI_TIMEOUT", 504);
      error.details = { backupAvailable: true, backupUrl: "/backup-clips/safe.wav" };
      throw error;
    },
  };
  const base = await serve(t, { idealGenerationService });
  const response = await fetch(`${base}/api/generate-ideal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), {
    success: false,
    error: "Voice generation is taking longer than expected.",
    errorCode: "OMNI_TIMEOUT",
    code: "OMNI_TIMEOUT",
    backupAvailable: true,
    backupUrl: "/backup-clips/safe.wav",
  });
});

test("runtime token updates require the admin key and never return the token", async (t) => {
  const updates = [];
  const runtimeConfig = {
    idealVoiceProvider: "omni", omniTimeoutMs: 40_000, omniSpaceId: "space", huggingFaceToken: "",
    tokenAdminKey: "admin-secret", elevenLabsApiKey: "test-only", elevenLabsReferenceVoiceId: "voice",
    maxScriptLength: 3_000, defaultDeliveryMode: "interview", profileDirectory: ".voice-profiles", backupDirectory: "backup-clips", issues: [],
  };
  const omniVoiceClient = { setToken: token => updates.push(token) };
  const base = await serve(t, { runtimeConfig, omniVoiceClient });
  const studio = await (await fetch(`${base}/api/studio-config`)).json();
  assert.equal(studio.tokenUpdateEnabled, true);

  const denied = await fetch(`${base}/api/admin/huggingface-token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adminKey: "wrong", token: "hf_replacement" }),
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(updates, []);

  const invalid = await fetch(`${base}/api/admin/huggingface-token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adminKey: "admin-secret", token: "not-a-token" }),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(updates, []);

  const updated = await fetch(`${base}/api/admin/huggingface-token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adminKey: "admin-secret", token: "hf_replacement" }),
  });
  const result = await updated.json();
  assert.equal(updated.status, 200);
  assert.deepEqual(result, { success: true });
  assert.deepEqual(updates, ["hf_replacement"]);
  assert.equal(JSON.stringify(result).includes("hf_replacement"), false);
});
