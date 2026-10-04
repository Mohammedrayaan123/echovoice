import test from "node:test";
import assert from "node:assert/strict";
import { createOmniVoiceClient } from "../server/omniVoiceClient.js";

test("Omni has one hard timeout and cancels the single submitted job", async () => {
  let submissions = 0;
  let cancellations = 0;
  const job = {
    cancel() { cancellations++; },
    async *[Symbol.asyncIterator]() { await new Promise(() => {}); },
  };
  const client = createOmniVoiceClient({
    timeoutMs: 15,
    clientApi: { connect: async () => ({ submit: () => { submissions++; return job; } }) },
    handleFile: (value) => value,
    logger: { info() {}, warn() {}, error() {} },
  });
  await assert.rejects(client.generate({
    script: "hello", referenceAudio: Buffer.from("raw"), referenceMimeType: "audio/wav", referenceTranscript: "raw",
    instruction: "calm", targetDuration: 2, targetSpeed: 1,
  }), (error) => error.code === "OMNI_TIMEOUT" && error.status === 504);
  assert.equal(submissions, 1);
  assert.equal(cancellations, 1);
});

test("malformed Omni output is rejected without a download attempt", async () => {
  let downloads = 0;
  const job = { async *[Symbol.asyncIterator]() { yield { type: "data", data: [null, "Done"] }; } };
  const client = createOmniVoiceClient({
    clientApi: { connect: async () => ({ submit: () => job }) },
    handleFile: (value) => value,
    fetchImpl: async () => { downloads++; return new Response(); },
    logger: { info() {}, warn() {}, error() {} },
  });
  await assert.rejects(client.generate({
    script: "hello", referenceAudio: Buffer.from("raw"), referenceMimeType: "audio/wav", referenceTranscript: "raw",
    instruction: "calm", targetDuration: 2, targetSpeed: 1,
  }), (error) => error.code === "OMNI_MALFORMED_OUTPUT");
  assert.equal(downloads, 0);
});

test("provider error status is reported as a failed generation rather than malformed audio", async () => {
  const job = { async *[Symbol.asyncIterator]() { yield { type: "data", data: [null, "Error: unsupported instruction"] }; } };
  const client = createOmniVoiceClient({
    clientApi: { connect: async () => ({ submit: () => job }) },
    handleFile: (value) => value,
    logger: { info() {}, warn() {}, error() {} },
  });
  await assert.rejects(client.generate({
    script: "hello", referenceAudio: Buffer.from("raw"), referenceMimeType: "audio/wav", referenceTranscript: "raw",
    instruction: "", targetDuration: 2, targetSpeed: 1,
  }), (error) => error.code === "OMNI_FAILED");
});

test("ZeroGPU quota failures are classified and a configured token stays server-side", async () => {
  let connectOptions;
  const job = { async *[Symbol.asyncIterator]() {
    yield { type: "status", stage: "error", message: "You have exceeded your ZeroGPU quota" };
  } };
  const client = createOmniVoiceClient({
    token: "hf_testtoken",
    clientApi: { connect: async (_space, options) => { connectOptions = options; return { submit: () => job }; } },
    handleFile: (value) => value,
    logger: { info() {}, warn() {}, error() {} },
  });
  await assert.rejects(client.generate({
    script: "hello", referenceAudio: Buffer.from("raw"), referenceMimeType: "audio/wav", referenceTranscript: "raw",
    instruction: "", targetDuration: 2, targetSpeed: 1,
  }), (error) => error.code === "OMNI_QUOTA_EXCEEDED" && error.status === 429);
  assert.equal(connectOptions.token, "hf_testtoken");
});

test("a connection that resolves after the hard timeout never submits a late paid job", async () => {
  let finishConnect;
  let submissions = 0;
  const connected = new Promise((resolve) => { finishConnect = resolve; });
  const client = createOmniVoiceClient({
    timeoutMs: 10,
    clientApi: { connect: () => connected },
    handleFile: (value) => value,
    logger: { info() {}, warn() {}, error() {} },
  });
  await assert.rejects(client.generate({
    script: "hello", referenceAudio: Buffer.from("raw"), referenceMimeType: "audio/wav", referenceTranscript: "raw",
    instruction: "calm", targetDuration: 2, targetSpeed: 1,
  }), (error) => error.code === "OMNI_TIMEOUT");
  finishConnect({ submit: () => { submissions++; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submissions, 0);
});

test("a manually updated token is used by future generations", async () => {
  const tokens = [];
  const client = createOmniVoiceClient({
    token: "hf_original",
    clientApi: { connect: async (_space, options) => {
      tokens.push(options.token);
      return { submit: () => ({ async *[Symbol.asyncIterator]() { yield { type: "status", stage: "error", message: "failed" }; } }) };
    } },
    handleFile: value => value,
    logger: { info() {}, warn() {}, error() {} },
  });
  client.setToken("hf_replacement");
  await assert.rejects(client.generate({
    script: "hello", referenceAudio: Buffer.from("raw"), referenceMimeType: "audio/wav", referenceTranscript: "raw",
    instruction: "", targetDuration: null, targetSpeed: 1,
  }));
  assert.deepEqual(tokens, ["hf_replacement"]);
});
