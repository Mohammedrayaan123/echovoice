// comparisonFeedback.js — translates comparisonViz.js's raw divergence data
// (semitone differences on a 20ms grid) into plain-language feedback: a
// score tier, 2-4 one-sentence insight cards, and a per-word color mapping
// for the script text. Pure functions only, no DOM — comparisonViz.js owns
// rendering all of this; this file just decides WHAT to say.
//
// GRID_STEP_SECONDS and NOTICEABLE_SEMITONES below intentionally mirror the
// same-named constants in comparisonViz.js (which owns the actual divergence
// calculation — this file only reads its output, never recomputes it). Kept
// as separate small constants here rather than threading them through every
// function signature, or importing from comparisonViz.js and risking a
// circular import (comparisonViz.js calls into this file too).
const GRID_STEP_SECONDS = 0.02;
const NOTICEABLE_SEMITONES = 2;

const PACE_TOLERANCE_RATIO = 0.15; // >15% shorter/longer than the ideal clip
// Direction comparisons use a lookback window (syllable-scale, ~100ms) rather
// than adjacent 20ms grid steps: natural speech glides move gradually — a few
// semitones over 100-300ms — so adjacent-frame deltas are dominated by noise
// and almost never cross a "real movement" threshold on their own.
const DIRECTION_WINDOW_STEPS = 5; // 5 * 20ms = 100ms
const DIRECTION_MIN_DELTA_SEMITONES = 0.4; // ignore sub-threshold wobble as "not really moving"
const HIGH_VARIANCE_SEMITONES = 3;
const LOW_VARIANCE_SEMITONES = 1.5;
const WORD_MIN_COUNT = 5; // below this, word-level highlighting isn't meaningful

/** @param {number} score 0-100 */
export function getScoreTier(score) {
  if (score <= 40) return { label: "Keep Practicing", colorVar: "--color-error" };
  if (score <= 70) return { label: "Getting There", colorVar: "--color-warning" };
  if (score <= 90) return { label: "Strong Delivery", colorVar: "--color-accent" };
  return { label: "Nailed It", colorVar: "--color-success" };
}

function regionForTime(time, duration) {
  const ratio = duration > 0 ? time / duration : 0;
  if (ratio < 1 / 3) return "opening";
  if (ratio < 2 / 3) return "middle";
  return "closing";
}

function computePaceFeedback(idealDuration, attemptDuration) {
  if (idealDuration <= 0) return { icon: "⏱️", text: "Your pacing matched the ideal well" };

  const ratio = (attemptDuration - idealDuration) / idealDuration;
  if (ratio < -PACE_TOLERANCE_RATIO) {
    return { icon: "⚡", text: "You spoke faster than the ideal — try slowing down" };
  }
  if (ratio > PACE_TOLERANCE_RATIO) {
    return { icon: "🐢", text: "You spoke slower than the ideal — try picking up the pace" };
  }
  return { icon: "⏱️", text: "Your pacing matched the ideal well" };
}

// Walks consecutive grid steps looking for places where the ideal pitch is
// clearly rising while the attempt is clearly falling (or vice versa), then
// groups consecutive mismatching steps into "spots" — a 200ms stretch of
// wrong-direction movement should read as one spot, not ten.
function computePitchDirectionFeedback(alignedIdeal, alignedAttempt, duration) {
  const mismatchFlags = [];
  for (let i = DIRECTION_WINDOW_STEPS; i < alignedIdeal.length; i++) {
    const idealPrev = alignedIdeal[i - DIRECTION_WINDOW_STEPS].pitch;
    const idealCur = alignedIdeal[i].pitch;
    const attemptPrev = alignedAttempt[i - DIRECTION_WINDOW_STEPS].pitch;
    const attemptCur = alignedAttempt[i].pitch;

    if (idealPrev == null || idealCur == null || attemptPrev == null || attemptCur == null) {
      mismatchFlags.push(false);
      continue;
    }

    const idealDelta = 12 * Math.log2(idealCur / idealPrev);
    const attemptDelta = 12 * Math.log2(attemptCur / attemptPrev);
    const bothMoving =
      Math.abs(idealDelta) >= DIRECTION_MIN_DELTA_SEMITONES && Math.abs(attemptDelta) >= DIRECTION_MIN_DELTA_SEMITONES;
    mismatchFlags.push(bothMoving && Math.sign(idealDelta) !== Math.sign(attemptDelta));
  }

  const spotTimes = [];
  let runStart = null;
  for (let i = 0; i < mismatchFlags.length; i++) {
    if (mismatchFlags[i]) {
      if (runStart === null) runStart = i;
    } else if (runStart !== null) {
      spotTimes.push(alignedIdeal[runStart + DIRECTION_WINDOW_STEPS].time);
      runStart = null;
    }
  }
  if (runStart !== null) spotTimes.push(alignedIdeal[runStart + DIRECTION_WINDOW_STEPS].time);

  const count = spotTimes.length;
  if (count > 5) {
    return {
      count,
      icon: "🔀",
      text: `Your pitch moved opposite to the ideal in ${count} spots — focus on matching the rise and fall`,
    };
  }
  if (count >= 2) {
    const counts = { opening: 0, middle: 0, closing: 0 };
    for (const t of spotTimes) counts[regionForTime(t, duration)]++;
    const region = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    return { count, icon: "↕️", text: `A few spots where your pitch went the wrong direction — mostly in your ${region}` };
  }
  return { count, icon: "✅", text: "Your pitch direction matched the ideal almost perfectly" };
}

function computeConsistencyFeedback(divergenceMap) {
  const values = divergenceMap.filter((p) => p.semitones != null).map((p) => p.semitones);
  if (values.length < 2) return null;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const absMean = values.reduce((a, b) => a + Math.abs(b), 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev > HIGH_VARIANCE_SEMITONES) {
    return { icon: "📊", text: "Your delivery was uneven — some parts matched well, others drifted significantly" };
  }
  if (stdDev < LOW_VARIANCE_SEMITONES) {
    const verdict = absMean < NOTICEABLE_SEMITONES ? "good" : "needs work";
    return { icon: "📊", text: `Consistent delivery throughout — ${verdict} across the board` };
  }
  return null; // middling variance — doesn't add anything the other cards don't already say
}

// Splits the clip into opening/middle/closing thirds and finds which had the
// best and worst match rate (using the same "within NOTICEABLE_SEMITONES"
// definition the overall score itself uses).
function computeSectionFeedback(divergenceMap, duration) {
  const thirds = { opening: [], middle: [], closing: [] };
  for (const point of divergenceMap) {
    if (point.diverges == null) continue;
    thirds[regionForTime(point.time, duration)].push(point.diverges);
  }

  const matchRates = {};
  for (const [region, flags] of Object.entries(thirds)) {
    if (flags.length === 0) continue;
    matchRates[region] = flags.filter((diverges) => !diverges).length / flags.length;
  }

  const regions = Object.keys(matchRates);
  if (regions.length < 2) return null; // not enough spread across the clip to compare sections

  regions.sort((a, b) => matchRates[b] - matchRates[a]);
  const strongest = regions[0];
  const weakest = regions[regions.length - 1];

  return {
    strongest: { icon: "💪", text: `Strongest section: your ${strongest}` },
    weakest:
      strongest === weakest ? null : { icon: "⚠️", text: `Needs work: your ${weakest} — try focusing there on the next attempt` },
  };
}

/**
 * Generates 2-4 one-sentence feedback cards from a compare() result. Pace and
 * the strongest/weakest section are always included when computable; pitch
 * direction and consistency fill any remaining slots (direction first) only
 * when they add real information, capped at 4 cards total.
 * @param {{idealDuration: number, attemptDuration: number, alignedIdeal: Array, alignedAttempt: Array, divergenceMap: Array, duration: number}} args
 * @returns {Array<{icon: string, text: string}>}
 */
export function generateFeedbackCards({ idealDuration, attemptDuration, alignedIdeal, alignedAttempt, divergenceMap, duration }) {
  const guaranteed = [computePaceFeedback(idealDuration, attemptDuration)];

  const sections = computeSectionFeedback(divergenceMap, duration);
  if (sections) {
    guaranteed.push(sections.strongest);
    if (sections.weakest) guaranteed.push(sections.weakest);
  }

  const optional = [];
  const direction = computePitchDirectionFeedback(alignedIdeal, alignedAttempt, duration);
  if (direction.count >= 2) optional.push({ icon: direction.icon, text: direction.text });

  const consistency = computeConsistencyFeedback(divergenceMap);
  if (consistency) optional.push(consistency);

  const remaining = Math.max(0, 4 - guaranteed.length);
  return [...guaranteed, ...optional.slice(0, remaining)].slice(0, 4);
}

function colorVarForSemitones(semitones) {
  if (semitones == null) return null; // no data at this instant — render as a plain, uncolored word
  const abs = Math.abs(semitones);
  if (abs < 1) return "--color-success";
  if (abs < 2) return "--color-accent";
  if (abs < 3) return "--color-warning";
  return "--color-error";
}

// divergenceMap is time-sorted and evenly spaced by GRID_STEP_SECONDS, so a
// word's estimated time maps directly to an index; if that exact instant is
// silent (null), search a short distance outward for the nearest real data.
function nearestSemitones(divergenceMap, time) {
  let idx = Math.round(time / GRID_STEP_SECONDS);
  idx = Math.max(0, Math.min(divergenceMap.length - 1, idx));
  if (divergenceMap[idx].semitones != null) return divergenceMap[idx].semitones;

  const SEARCH_RADIUS = 8; // ~160ms at a 20ms grid
  for (let r = 1; r <= SEARCH_RADIUS; r++) {
    if (divergenceMap[idx - r]?.semitones != null) return divergenceMap[idx - r].semitones;
    if (divergenceMap[idx + r]?.semitones != null) return divergenceMap[idx + r].semitones;
  }
  return null;
}

/**
 * Distributes the script's words evenly across the ideal clip's duration
 * (approximate — no per-word timestamps are available on the ElevenLabs
 * Starter plan) and colors each by how well the attempt matched at that
 * moment.
 * @param {string} scriptText
 * @param {number} duration
 * @param {Array<{time: number, semitones: number|null}>} divergenceMap
 * @returns {Array<{word: string, colorVar: string|null}>|null} null if there
 *   are too few words for word-level highlighting to be meaningful
 */
export function mapWordsToColors(scriptText, duration, divergenceMap) {
  const words = scriptText.trim().split(/\s+/).filter(Boolean);
  if (words.length < WORD_MIN_COUNT) return null;

  return words.map((word, i) => {
    const time = (i / words.length) * duration;
    return { word, colorVar: colorVarForSemitones(nearestSemitones(divergenceMap, time)) };
  });
}
