import test from "node:test";
import assert from "node:assert/strict";
import { buildInstruction, calculateTargetSpeed, createDeliveryPlanner, MODE_PROFILES, validateDeliveryInput } from "../server/deliveryPlanner.js";

test("delivery modes stay centralized and instructions are concise, mode-specific, and duration-aware", async () => {
  assert.deepEqual(Object.keys(MODE_PROFILES), ["interview", "presentation", "storytelling", "admissions"]);
  const logged = [];
  const planner = createDeliveryPlanner({
    elevenLabsClient: { generateReference: async () => ({ audio: Buffer.from("mp3"), mimeType: "audio/mpeg", durationSeconds: 2 }) },
    audioLogger: { log: async (...args) => logged.push(args) },
    logger: { info() {} },
    maxScriptLength: 3000,
  });
  const result = await planner.plan({ script: "one two three four", mode: "interview" });
  assert.equal(result.wordCount, 4);
  assert.equal(result.measuredWpm, 120);
  assert.equal(result.targetDuration, 2);
  assert.equal(result.targetSpeed, 0.89);
  assert.equal(result.instruction, "Speak calmly and confidently in a conversational interview style. Use brief natural pauses after major ideas. Add moderate emphasis to key points. Target approximately 2.0 seconds overall.");
  assert.equal(result.providerInstruction, "");
  assert.equal(result.providerTargetDuration, null);
  assert.equal(logged[0][1], "reference-reading");
});

test("target speed uses one documented clamped mapping", () => {
  assert.equal(calculateTargetSpeed(50), 0.85);
  assert.equal(calculateTargetSpeed(135), 1);
  assert.equal(calculateTargetSpeed(200), 1.15);
  assert.match(buildInstruction(MODE_PROFILES.admissions, 18.2), /Target approximately 18\.2 seconds overall\.$/);
});

test("planner validation rejects missing scripts, invalid modes, and configured length overruns", () => {
  assert.throws(() => validateDeliveryInput({ script: "", mode: "interview" }), (error) => error.code === "no_text");
  assert.throws(() => validateDeliveryInput({ script: "hello", mode: "debate" }), (error) => error.code === "invalid_mode");
  assert.throws(() => validateDeliveryInput({ script: "x".repeat(11), mode: "interview" }, { maxScriptLength: 10 }), (error) => error.code === "text_too_long");
});
