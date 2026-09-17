// pitchViz.js — per-word pitch visualization, synced to playback.
//
// Pipeline:
// 1. Extract a pitch contour from the generated audio (pitchUtils.js).
// 2. Group ElevenLabs' CHARACTER-level alignment into words (pitchUtils.js).
// 3. For each word, compare early vs. late pitch within its time window to
//    classify it as rising / falling / flat.
// 4. Render the words as spans and highlight the current one in sync with the
//    <audio> element's playback, using its own timestamps.
//
// This is a bonus visual feature — any failure here must never break the core
// record -> generate -> hear-it-back flow, so every entry point is wrapped and
// degrades to a plain message instead of throwing.

import { extractPitchContour, groupCharactersIntoWords } from "./pitchUtils.js";

const TREND_THRESHOLD_HZ = 6; // ignore small wobble; only call it a trend past this

let container = null;
let activeWords = []; // [{ text, start, end, trend, el }]
let rafHandle = null;

export function init(el) {
  container = el;
}

function average(nums) {
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function classifyTrend(word, pitchPoints) {
  const inWord = pitchPoints.filter((p) => p.time >= word.start && p.time <= word.end);
  if (inWord.length < 2) return "flat"; // not enough voiced signal to call a direction

  const mid = Math.max(1, Math.floor(inWord.length / 2));
  const earlyAvg = average(inWord.slice(0, mid).map((p) => p.frequency));
  const lateAvg = average(inWord.slice(mid).map((p) => p.frequency));
  const diff = lateAvg - earlyAvg;

  if (diff > TREND_THRESHOLD_HZ) return "rising";
  if (diff < -TREND_THRESHOLD_HZ) return "falling";
  return "flat";
}

function renderWords(words) {
  container.innerHTML = "";
  container.classList.add("pitch-viz-ready");

  activeWords = words.map((word) => {
    const el = document.createElement("span");
    el.className = `pitch-word trend-${word.trend}`;
    el.textContent = word.text;
    container.appendChild(el);
    container.appendChild(document.createTextNode(" "));
    return { ...word, el };
  });
}

function startHighlightSync(audioEl) {
  cancelAnimationFrame(rafHandle);

  function tick() {
    const t = audioEl.currentTime;
    for (const word of activeWords) {
      word.el.classList.toggle("active", t >= word.start && t < word.end);
    }
    if (!audioEl.paused && !audioEl.ended) {
      rafHandle = requestAnimationFrame(tick);
    }
  }

  audioEl.addEventListener("play", () => {
    cancelAnimationFrame(rafHandle);
    tick();
  });
  audioEl.addEventListener("pause", () => cancelAnimationFrame(rafHandle));
  audioEl.addEventListener("ended", () => {
    cancelAnimationFrame(rafHandle);
    activeWords.forEach((w) => w.el.classList.remove("active"));
  });
}

/**
 * Build and wire up the pitch visualization for one generated line.
 * @param {string} audioUrl - the object URL returned by synthesizeSpeech
 * @param {object|null} alignment - getLastAlignment() from tts.js
 * @param {HTMLAudioElement} audioEl - the <audio> element that plays audioUrl
 */
export async function render(audioUrl, alignment, audioEl) {
  if (!container) return;

  if (!alignment) {
    container.textContent = "Pitch data wasn't available for this generation.";
    return;
  }

  container.textContent = "Analyzing pitch...";

  try {
    const [pitchPoints, words] = await Promise.all([
      extractPitchContour(audioUrl),
      Promise.resolve(groupCharactersIntoWords(alignment)),
    ]);

    words.forEach((word) => {
      word.trend = classifyTrend(word, pitchPoints);
    });

    renderWords(words);
    startHighlightSync(audioEl);
  } catch (err) {
    container.textContent = `Pitch visualization unavailable (${err.message}).`;
  }
}
