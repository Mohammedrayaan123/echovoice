import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createIdealGenerationService } from "../server/idealGenerationService.js";
import { OmniVoiceError } from "../server/omniVoiceClient.js";
import { saveBackupClip } from "../server/backupClips.js";
import { createAudioLogger } from "../server/audioLogger.js";

function config(overrides = {}) {
  return { idealVoiceProvider: "omni", maxScriptLength: 3000, defaultDeliveryMode: "interview", backupDirectory: "unused", ...overrides };
}

function planner() {
  return { plan: async ({ script, mode }) => ({
    script, mode, instruction: `instruction:${mode}`, providerInstruction: "", providerTargetDuration: null,
    targetDuration: 12.3, targetSpeed: 0.97, measuredWpm: 131,
  }) };
}

test("identical concurrent plans share one reference reading but receive independent single-use IDs", async () => {
  let readings = 0;
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const service = createIdealGenerationService({
    config: config(),
    deliveryPlanner: { plan: async input => { readings++; await gate; return planner().plan(input); } },
    voiceProfileStore: { get: async () => ({ audio: Buffer.from("raw"), transcript: "sample", mimetype: "audio/wav" }) },
    omniVoiceClient: { generate: async () => ({ audio: Buffer.from("ideal"), mimeType: "audio/wav" }) },
  });
  const input = { script: "The same exact script.", mode: "interview" };
  const first = service.plan(input);
  const second = service.plan(input);
  await Promise.resolve();
  assert.equal(readings, 1);
  finish();
  const [a, b] = await Promise.all([first, second]);
  const c = await service.plan(input);
  assert.equal(readings, 1);
  assert.equal(new Set([a.plannerId, b.plannerId, c.plannerId]).size, 3);
  for (const plan of [a, b]) {
    const request = { ...input, plannerId: plan.plannerId, voiceProfileId: "profile" };
    assert.equal((await service.generate(request)).success, true);
    await assert.rejects(service.generate(request), error => error.code === "plan_expired");
  }
  await service.plan({ ...input, mode: "admissions" });
  await service.plan({ ...input, script: "Changed script." });
  assert.equal(readings, 3);
});

test("failed reference readings can be retried and cached metadata expires", async t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  let readings = 0;
  const service = createIdealGenerationService({ config: config(), deliveryPlanner: {
    plan: async input => { if (++readings === 1) throw new Error("temporary failure"); return planner().plan(input); },
  } });
  const input = { script: "Try the same script.", mode: "interview" };
  await assert.rejects(service.plan(input), /temporary failure/);
  await service.plan(input);
  await service.plan(input);
  assert.equal(readings, 2);
  now += 5 * 60_000 + 1;
  await service.plan(input);
  assert.equal(readings, 3);
});

test("Omni generation consumes the saved raw sample and returns the provider-agnostic ideal audio contract", async () => {
  let submitted;
  const logs = [];
  const service = createIdealGenerationService({
    config: config(),
    deliveryPlanner: planner(),
    omniVoiceClient: { generate: async (input) => { submitted = input; return { audio: Buffer.from("ideal"), mimeType: "audio/wav" }; } },
    voiceProfileStore: { get: async () => ({ voiceId: "voice_1", audio: Buffer.from("raw"), mimetype: "audio/webm", transcript: "raw sample words" }) },
    audioLogger: { log: async (...args) => logs.push(args) },
  });
  const plan = await service.plan({ script: "Practice this answer.", mode: "interview" });
  const result = await service.generate({ plannerId: plan.plannerId, script: "Practice this answer.", mode: "interview", voiceId: "voice_1", voiceProfileId: "profile_1" });
  assert.equal(Buffer.from(result.audioBase64, "base64").toString(), "ideal");
  assert.equal(result.mimeType, "audio/wav");
  assert.equal(result.alignment, null);
  assert.equal(submitted.referenceTranscript, "raw sample words");
  assert.equal(submitted.instruction, "");
  assert.equal(submitted.targetDuration, null);
  assert.equal(submitted.targetSpeed, 0.97);
  assert.equal(logs[0][1], "ideal-omni");
});

test("Omni failure reports only a matching deterministic backup clip", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "echovoice-backup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = "A matching backup script.";
  const saved = await saveBackupClip(directory, script, "storytelling", Buffer.from("audio"), "audio/wav");
  const service = createIdealGenerationService({
    config: config({ backupDirectory: directory }),
    deliveryPlanner: planner(),
    omniVoiceClient: { generate: async () => { throw new OmniVoiceError("slow", "OMNI_TIMEOUT", 504); } },
    voiceProfileStore: { get: async () => ({ voiceId: "voice", audio: Buffer.from("raw"), mimetype: "audio/wav", transcript: "words" }) },
  });
  const plan = await service.plan({ script, mode: "storytelling" });
  await assert.rejects(
    service.generate({ plannerId: plan.plannerId, script, mode: "storytelling", voiceId: "voice", voiceProfileId: "profile" }),
    (error) => error.code === "OMNI_TIMEOUT" && error.details.backupAvailable === true && error.details.backupUrl.endsWith(encodeURIComponent(saved.filename)),
  );
});

test("the operator switch keeps pure ElevenLabs generation and skips Omni planning", async () => {
  let omniCalls = 0;
  let synthInput;
  const service = createIdealGenerationService({
    config: config({ idealVoiceProvider: "elevenlabs" }),
    voiceService: { synthesize: async (input) => { synthInput = input; return { audioBase64: Buffer.from("eleven").toString("base64"), mimeType: "audio/mpeg", alignment: { characters: [] } }; } },
    deliveryPlanner: { plan: async () => { throw new Error("planner should not run"); } },
    omniVoiceClient: { generate: async () => { omniCalls++; } },
    audioLogger: { log: async () => {} },
  });
  const plan = await service.plan({ script: "Old path", mode: "presentation" });
  const result = await service.generate({ plannerId: plan.plannerId, script: "Old path", mode: "presentation", voiceId: "voice", modelId: "eleven_v3" });
  assert.equal(Buffer.from(result.audioBase64, "base64").toString(), "eleven");
  assert.equal(synthInput.voiceId, "voice");
  assert.equal(synthInput.modelId, "eleven_v3");
  assert.equal(omniCalls, 0);
});

test("missing raw audio and transcript fail clearly before Omni is called", async () => {
  let omniCalls = 0;
  const base = { config: config(), deliveryPlanner: planner(), omniVoiceClient: { generate: async () => { omniCalls++; } } };
  const missingSample = createIdealGenerationService({ ...base, voiceProfileStore: { get: async () => { throw new Error("must not be called"); } } });
  let plan = await missingSample.plan({ script: "Hello", mode: "interview" });
  await assert.rejects(missingSample.generate({ plannerId: plan.plannerId, script: "Hello", mode: "interview", voiceId: "voice" }), (error) => error.code === "missing_voice_sample");

  const missingTranscript = createIdealGenerationService({ ...base, voiceProfileStore: { get: async () => ({ voiceId: "voice", audio: Buffer.from("raw"), mimetype: "audio/wav", transcript: "" }) } });
  plan = await missingTranscript.plan({ script: "Hello", mode: "interview" });
  await assert.rejects(missingTranscript.generate({ plannerId: plan.plannerId, script: "Hello", mode: "interview", voiceId: "voice", voiceProfileId: "profile" }), (error) => error.code === "missing_reference_transcript");
  assert.equal(omniCalls, 0);
});

test("best-effort audio logging absorbs Supabase failures", async () => {
  let warnings = 0;
  const storage = { from: () => ({ upload: async () => ({ error: new Error("offline") }), getPublicUrl: () => ({ data: {} }) }) };
  const logger = createAudioLogger({ supabaseClient: { storage }, logger: { warn: () => warnings++ }, saveLocalAudio: false });
  assert.equal(await logger.log(Buffer.from("audio"), "ideal-omni", "audio/wav"), null);
  assert.equal(warnings, 1);
});
