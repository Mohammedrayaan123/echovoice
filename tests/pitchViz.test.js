import test from "node:test";
import assert from "node:assert/strict";
import { estimateWordTimings } from "../public/js/pitchViz.js";

test("estimated read-along timing covers the clip and gives punctuation extra pause weight", () => {
  const words = estimateWordTimings("Wait, then speak.", 6);
  assert.deepEqual(words.map(({ text }) => text), ["Wait,", "then", "speak."]);
  assert.equal(words[0].start, 0);
  assert.equal(words.at(-1).end, 6);
  assert.ok(words[0].end - words[0].start > words[1].end - words[1].start);
  assert.deepEqual(estimateWordTimings("", 6), []);
  assert.deepEqual(estimateWordTimings("hello", NaN), []);
});
