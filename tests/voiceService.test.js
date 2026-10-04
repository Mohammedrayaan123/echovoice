import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceService, resolveVoiceSettings, validateSpeechInput } from "../server/voiceService.js";

const audioResult = { audio_base64: "YXVkaW8=", alignment: { characters: ["a"] } };
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("v3 receives only discrete stability, with Natural as the default", () => {
  assert.deepEqual(resolveVoiceSettings("eleven_v3"), { stability: 0.5 });
  assert.deepEqual(resolveVoiceSettings("eleven_v3", { stability: 0.61, similarity_boost: 1, style: 1, use_speaker_boost: true }), { stability: 0.5 });
  assert.deepEqual(resolveVoiceSettings("eleven_v3", { stability: 0.1 }), { stability: 0 });
  assert.deepEqual(resolveVoiceSettings("eleven_v3", { stability: 0.92 }), { stability: 1 });
});

test("missing or malformed settings do not become extreme zero values", () => {
  assert.deepEqual(resolveVoiceSettings("eleven_multilingual_v2", { stability: null, similarity_boost: "", style: false }), {
    stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true,
  });
  assert.equal(resolveVoiceSettings("eleven_multilingual_v2", { stability: 0 }).stability, 0);
  assert.equal(resolveVoiceSettings("eleven_multilingual_v2", { similarity_boost: 4 }).similarity_boost, 1);
});

test("language is omitted for Multilingual v2 and preserved on supported models", () => {
  const input = { voiceId: "my_voice", text: " مرحباً ", languageCode: "ar" };
  assert.equal(validateSpeechInput(input).requestBody.language_code, undefined);
  assert.equal(validateSpeechInput({ ...input, modelId: "eleven_v3" }).requestBody.language_code, "ar");
  assert.equal(validateSpeechInput({ ...input, modelId: "eleven_flash_v2_5" }).requestBody.language_code, "ar");
  assert.equal(validateSpeechInput({ ...input, modelId: "toString" }).model, "eleven_multilingual_v2");
});

test("invalid voice IDs, scripts, languages and model length limits fail before spending credits", () => {
  const base = { voiceId: "my_voice", text: "Hello." };
  for (const input of [null, { ...base, voiceId: "../other" }, { ...base, voiceId: {} }, { ...base, text: ["hi"] }, { ...base, text: "  " }, { ...base, languageCode: "en/invalid" }]) {
    assert.throws(() => validateSpeechInput(input), (error) => error.code === "bad_request");
  }
  assert.throws(() => validateSpeechInput({ ...base, text: "x".repeat(5001), modelId: "eleven_v3" }), (error) => error.code === "text_too_long");
  assert.equal(validateSpeechInput({ ...base, text: "x".repeat(5001) }).requestBody.text.length, 5001);
});

test("the complete response body remains covered by the timeout without a paid retry", async () => {
  let calls = 0;
  const service = createVoiceService({ apiKey: "test-only", speechTimeoutMs: 15, fetchImpl: async (url, options) => {
    calls++;
    return {
      ok: true,
      json: () => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })),
    };
  } });
  await assert.rejects(service.synthesize({ voiceId: "voice", text: "hello" }), (error) => error.code === "timeout" && error.status === 504);
  assert.equal(calls, 1);
});

test("an unreachable voice provider is identified separately from an unreachable app server", async () => {
  const service = createVoiceService({ apiKey: "test-only", fetchImpl: async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "EACCES" } });
  } });
  await assert.rejects(service.synthesize({ voiceId: "voice", text: "hello" }), (error) => error.code === "provider_network_error" && error.status === 502);
});

test("provider detail.status and detail.code map to safe errors without exposing diagnostics", async () => {
  for (const [status, field, value, expected] of [
    [400, "status", "voice_limit_reached", "voice_limit_reached"],
    [401, "status", "quota_exceeded", "quota_exceeded"],
    [404, "code", "voice_not_found", "voice_not_found"],
    [403, "status", "voice_requires_verification", "verification_required"],
    [422, "code", "invalid_audio", "invalid_audio"],
    [401, "code", "other", "auth_error"],
  ]) {
    const service = createVoiceService({ apiKey: "secret-test-key", fetchImpl: async () => jsonResponse({ detail: { [field]: value, message: "secret-test-key internal diagnostics" } }, status) });
    await assert.rejects(service.synthesize({ voiceId: "voice", text: "hello" }), (error) => error.code === expected && !error.message.includes("secret-test-key"));
  }
});

test("HTML provider errors, missing voice IDs and empty audio produce actionable failures", async () => {
  const htmlService = createVoiceService({ apiKey: "test", fetchImpl: async () => new Response("<html>unavailable</html>", { status: 503 }) });
  await assert.rejects(htmlService.synthesize({ voiceId: "voice", text: "hello" }), (error) => error.code === "server_error");
  const emptyService = createVoiceService({ apiKey: "test", fetchImpl: async () => jsonResponse({}) });
  await assert.rejects(emptyService.synthesize({ voiceId: "voice", text: "hello" }), (error) => error.code === "server_error");
  await assert.rejects(emptyService.clone([{ size: 3, buffer: Buffer.from("wav"), mimetype: "audio/wav" }]), (error) => error.code === "server_error");
});

test("timestamps and actual model settings remain compatible with the browser", async () => {
  let submitted;
  const service = createVoiceService({ apiKey: "test", fetchImpl: async (url, options) => {
    submitted = { url, ...JSON.parse(options.body) };
    return jsonResponse(audioResult);
  } });
  const result = await service.synthesize({ voiceId: "my_voice", text: "Hello.", modelId: "eleven_v3", voiceSettings: { stability: 0.47, similarity_boost: 1 } });
  assert.deepEqual(submitted.voice_settings, { stability: 0.5 });
  assert.match(submitted.url, /my_voice\/with-timestamps\?output_format=mp3_44100_128$/);
  assert.equal(result.modelUsed, "eleven_v3");
  assert.equal(result.mimeType, "audio/mpeg");
  assert.deepEqual(result.alignment, audioResult.alignment);
});
