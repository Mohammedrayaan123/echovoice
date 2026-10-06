import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDivergence } from '../public/js/comparisonMath.js';
const pattern = (fn = t => 4 * Math.sin(t * 2 * Math.PI / 2)) => Array.from({ length: 501 }, (_, i) => ({ time: i * 0.02, frequency: 160 * 2 ** (fn(i * 0.02) / 12) }));

test('delayed starts, register shifts and modest pace changes preserve modulation', () => {
  const ideal = pattern();
  for (const attempt of [ideal, ideal.map(p => ({ ...p, time: p.time + 0.5 })), ideal.map(p => ({ ...p, frequency: p.frequency * 2 ** (2.1 / 12) })), ideal.map(p => ({ ...p, time: p.time * 1.15 + 0.4 }))]) {
    const result = computeDivergence(ideal, attempt);
    assert.ok(result.score >= 98, JSON.stringify(result.score));
  }
});
test('a partial passage cannot receive a perfect full-attempt score', () => {
  const ideal = pattern();
  assert.equal(computeDivergence(ideal, ideal.filter(p => p.time <= 2)).score, null);
  assert.equal(computeDivergence(ideal, ideal.filter(p => p.time < 2 || p.time > 8)).score, null);
});
test('expressive matching outranks flat or reversed contours and credit is gradual', () => {
  const ideal = pattern();
  const exact = computeDivergence(ideal, ideal).score;
  const flat = computeDivergence(ideal, pattern(() => 0)).score;
  const reversed = computeDivergence(ideal, pattern(t => -4 * Math.sin(t * 2 * Math.PI / 2))).score;
  assert.ok(exact > flat + 20);
  assert.ok(exact > reversed + 20);
  const one = computeDivergence(ideal, pattern(t => 2 * Math.sin(t * Math.PI))).score;
  const two = computeDivergence(ideal, pattern(t => 1.9 * Math.sin(t * Math.PI))).score;
  assert.ok(one > 0 && one < 100);
  assert.ok(Math.abs(one - two) < 6);
});
test('pacing and pause evidence remains separate from the aligned modulation score', () => {
  const ideal = pattern();
  const result = computeDivergence(ideal, ideal.map(p => ({ ...p, time: p.time * 1.15 + 2 })));
  assert.equal(result.paceDifference, 15);
  assert.equal(result.attemptStart, 2);
  const gap = computeDivergence(ideal, ideal.filter(p => p.time < 4 || p.time > 5));
  assert.ok(gap.pauseOverlap < result.pauseOverlap);
  assert.equal(computeDivergence([], []).score, null);
  assert.equal(computeDivergence(pattern(() => 0), pattern(() => 0)).flatReference, true);
});
