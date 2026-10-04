import test from "node:test";
import assert from "node:assert/strict";

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const audioResult = { audioBase64: "YXVkaW8=", mimeType: "audio/mpeg", alignment: null, modelUsed: "eleven_multilingual_v2" };

test("explicit creation caches the recording so generation does not create a second clone", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/clone-voice") return jsonResponse({ voiceId: "voice_one", requiresVerification: false });
    if (url === "/save-audio") return jsonResponse({ ok: true });
    return jsonResponse(audioResult);
  });
  const tts = await import(`../public/js/tts.js?cache=${Date.now()}`);
  const blob = new Blob(["sample"], { type: "audio/webm" });
  await tts.createVoiceProfile(blob, "My Voice");
  const result = await tts.synthesizeSpeech("Hello", blob);
  assert.equal(calls.filter(({ url }) => url === "/api/clone-voice").length, 1);
  assert.equal(result.voiceId, "voice_one");
  URL.revokeObjectURL(result.url);
});

test("a provider verification requirement cannot be mistaken for a ready profile", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ voiceId: "voice_pending", requiresVerification: true }));
  const tts = await import(`../public/js/tts.js?verification=${Date.now()}`);
  await assert.rejects(tts.createVoiceProfile(new Blob(["audio"], { type: "audio/wav" })), (error) => error.code === "verification_required" && error.voiceId === "voice_pending");
  await assert.rejects(tts.synthesizeSpeech("Hello", null), (error) => error.code === "no_voice");
});

test("multiple clean samples are uploaded together, malformed success responses fail safely", async (t) => {
  let uploaded;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/clone-voice") {
      uploaded = options.body;
      return jsonResponse({ voiceId: "voice_many" });
    }
    return jsonResponse({});
  });
  const tts = await import(`../public/js/tts.js?multi=${Date.now()}`);
  await tts.createVoiceProfile([new Blob(["first"], { type: "audio/wav" }), new Blob(["second"], { type: "audio/mp4" })]);
  assert.equal(uploaded.getAll("audio").length, 2);
  assert.equal(uploaded.getAll("audio")[1].name, "sample-2.mp4");
  await assert.rejects(tts.synthesizeSpeech("Hello", null), (error) => error.code === "server_error");
});

test("hybrid client uses the two production routes and accepts Omni audio without exposing a provider", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url === "/api/plan-delivery") return jsonResponse({ plannerId: "planner", instruction: "calm", targetDuration: 3, targetSpeed: 1, measuredWpm: 120 });
    if (url === "/api/generate-ideal") return jsonResponse({ success: true, audioBase64: "YXVkaW8=", mimeType: "audio/wav", alignment: null });
    throw new Error("unexpected route");
  });
  const tts = await import(`../public/js/tts.js?hybrid=${Date.now()}`);
  const plan = await tts.planIdealDelivery("Hello there", "storytelling");
  const result = await tts.generateIdealSpeech({ script: "Hello there", mode: "storytelling", plannerId: plan.plannerId, voiceId: "voice", voiceProfileId: "profile" });
  assert.deepEqual(calls.map(({ url }) => url), ["/api/plan-delivery", "/api/generate-ideal"]);
  assert.equal(calls[1].body.voiceProfileId, "profile");
  assert.equal(typeof result.url, "string");
  URL.revokeObjectURL(result.url);
});

test("hybrid client preserves structured backup recovery on timeout", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse({
    success: false, error: "slow", errorCode: "OMNI_TIMEOUT", backupAvailable: true, backupUrl: "/backup-clips/match.wav",
  }, 504));
  const tts = await import(`../public/js/tts.js?backup=${Date.now()}`);
  await assert.rejects(tts.generateIdealSpeech({ script: "Hello", mode: "interview", plannerId: "plan", voiceId: "voice", voiceProfileId: "profile" }),
    (error) => error.code === "OMNI_TIMEOUT" && error.backupAvailable === true && error.backupUrl === "/backup-clips/match.wav");
});

test("voice preview sends the saved reference identity and accepts WAV audio", async (t) => {
  let submitted;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/preview-voice");
    submitted = JSON.parse(options.body);
    return jsonResponse({ audioBase64: "YXVkaW8=", mimeType: "audio/wav", alignment: null });
  });
  const tts = await import(`../public/js/tts.js?preview=${Date.now()}`);
  const result = await tts.previewVoice("  My own words.  ", { voiceId: "local_voice", voiceProfileId: "profile", languageCode: "en" });
  assert.deepEqual(submitted, { text: "My own words.", voiceId: "local_voice", voiceProfileId: "profile", languageCode: "en" });
  assert.equal(typeof result.url, "string");
  assert.equal(result.alignment, null);
  URL.revokeObjectURL(result.url);
});

test("voice preview rejects unusable output and preserves actionable provider failures", async (t) => {
  let failure = false;
  t.mock.method(globalThis, "fetch", async () => failure
    ? jsonResponse({ error: "The reference is missing.", errorCode: "missing_voice_sample" }, 400)
    : jsonResponse({ audioBase64: "YXVkaW8=", mimeType: "text/html" }));
  const tts = await import(`../public/js/tts.js?previewErrors=${Date.now()}`);
  await assert.rejects(tts.previewVoice("Hello", { voiceId: "local_voice", voiceProfileId: "profile" }), (error) => error.code === "server_error");
  failure = true;
  await assert.rejects(tts.previewVoice("Hello", { voiceId: "local_voice", voiceProfileId: "profile" }), (error) => error.code === "missing_voice_sample");
});
