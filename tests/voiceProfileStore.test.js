import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createVoiceProfileStore } from "../server/voiceProfileStore.js";

test("private voice profiles use generated paths and infer safe audio metadata", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "echovoice-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createVoiceProfileStore({ directory });
  const profileId = await store.save({
    file: { buffer: Buffer.from("wav bytes"), mimetype: "application/octet-stream", originalname: "../../unsafe.wav" },
    transcript: "the exact words", voiceId: "voice_1",
  });
  const profile = await store.get(profileId);
  assert.equal(profile.audioName, "reference.wav");
  assert.equal(profile.mimetype, "audio/wav");
  assert.equal(profile.audio.toString(), "wav bytes");
  await assert.rejects(store.get("../outside"), (error) => error.code === "missing_voice_sample");
});
