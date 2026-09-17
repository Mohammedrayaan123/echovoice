// pitchUtils.js — shared pitch-detection and alignment helpers, used by both
// pitchViz.js (per-word rising/falling arrows) and comparisonViz.js (side-by-side
// AI vs. user pitch comparison). Extracted here so both features run the exact
// same, once-tested extraction code instead of two copies drifting apart.

import { PitchDetector } from "../vendor/pitchy.js";

const WINDOW_SIZE = 2048; // samples per pitch-detection window
const HOP_SIZE = 512; // samples between windows (overlap = better time resolution)
const MIN_CLARITY = 0.8; // Pitchy's own confidence score (0-1); below this = unvoiced/noise
const MIN_HZ = 60; // outside typical human voice fundamental range = treat as noise
const MAX_HZ = 500;

/**
 * Decode an audio URL and run Pitchy over it to get a pitch-over-time contour.
 * @param {string} audioUrl
 * @returns {Promise<Array<{time: number, frequency: number}>>}
 */
export async function extractPitchContour(audioUrl) {
  const arrayBuffer = await (await fetch(audioUrl)).arrayBuffer();

  // OfflineAudioContext, not a live AudioContext — decodeAudioData lives on any
  // BaseAudioContext, and this is decode-only (nothing is ever rendered/played
  // from it), so it doesn't need real audio hardware and doesn't count against
  // a browser's live-AudioContext limit. The (1, 1, 44100) args are otherwise
  // unused — decodeAudioData ignores them and returns the buffer at its own
  // native sample rate.
  const offlineCtx = new OfflineAudioContext(1, 1, 44100);
  const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer);
  const samples = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;

  const detector = PitchDetector.forFloat32Array(WINDOW_SIZE);
  const window_ = new Float32Array(WINDOW_SIZE);
  const points = [];

  for (let start = 0; start + WINDOW_SIZE <= samples.length; start += HOP_SIZE) {
    window_.set(samples.subarray(start, start + WINDOW_SIZE));
    const [frequency, clarity] = detector.findPitch(window_, sampleRate);
    if (clarity >= MIN_CLARITY && frequency >= MIN_HZ && frequency <= MAX_HZ) {
      points.push({ time: start / sampleRate, frequency });
    }
  }

  return points;
}

/**
 * ElevenLabs gives per-CHARACTER timing, not per-word — this reconstructs words
 * by splitting on whitespace, using the first/last character's timing as the
 * word's start/end.
 * @param {{characters: string[], character_start_times_seconds: number[], character_end_times_seconds: number[]}} alignment
 * @returns {Array<{text: string, start: number, end: number}>}
 */
export function groupCharactersIntoWords(alignment) {
  const characters = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds;

  const words = [];
  let current = null;

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = null;
      }
      continue;
    }
    if (!current) current = { text: "", start: starts[i], end: ends[i] };
    current.text += ch;
    current.end = ends[i];
  }
  if (current) words.push(current);

  return words;
}
