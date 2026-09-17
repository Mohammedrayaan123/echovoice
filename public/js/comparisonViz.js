// comparisonViz.js — Side-by-Side Delivery Comparison: the app's core
// differentiator. Extracts pitch contours from the AI-generated "ideal"
// delivery and the user's own recorded attempt (via pitchUtils.js, shared
// with pitchViz.js's per-word trend feature), time-aligns them, scores how
// closely they match in semitones, and draws both as smooth contours on a
// pair of stacked <canvas> panels with divergence bands and a synced
// playhead — per DESIGN.md's "Comparison Split View" spec.
//
// Bonus-feature contract, same as pitchViz.js: any failure here (bad decode,
// too little voiced signal, etc.) degrades to a friendly inline message.
// It must never break playback of either the AI clip or the user's attempt —
// those <audio> elements are owned by app.js and keep working regardless of
// whether this module can draw anything.

import { extractPitchContour } from "./pitchUtils.js";

const GRID_STEP_SECONDS = 0.02; // 20ms alignment grid, per spec
const VOICED_GAP_TOLERANCE_SECONDS = 0.12; // no raw pitch point within this = silence at that instant
const NOTICEABLE_SEMITONES = 2; // > this = "diverges" for banding + the match-% score
const PANEL_HEIGHT_CSS = 160; // px — matches the spec'd canvas height
const PAD_X_CSS = 4;
const PAD_Y_CSS = 8;

let idealCanvas = null;
let attemptCanvas = null;
let badgeEl = null;
let messageEl = null;
let panelsEl = null;

// Cached off-DOM canvases holding the static contour+band drawing, so the
// playhead can redraw every animation frame by compositing two images
// instead of re-walking every point and re-stroking bezier segments at 60fps.
const idealBase = document.createElement("canvas");
const attemptBase = document.createElement("canvas");

let currentXScale = null; // (seconds) => device px, or null when nothing's drawn

export function init({ idealCanvas: ideal, attemptCanvas: attempt, badgeEl: badge, messageEl: message, panelsEl: panels }) {
  idealCanvas = ideal;
  attemptCanvas = attempt;
  badgeEl = badge;
  messageEl = message;
  panelsEl = panels;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// --- Step 3: time-alignment + semitone divergence -------------------------

// Two-pointer linear interpolation: points and gridTimes are both time-sorted
// ascending, so the search index only ever moves forward (O(n+m) total, not
// O(n*m)). Returns null outside the contour's range or across a gap wider
// than VOICED_GAP_TOLERANCE_SECONDS (unvoiced/silence — don't fabricate a
// pitch by interpolating across it).
function resampleLinear(points, gridTimes) {
  const out = new Array(gridTimes.length).fill(null);
  if (points.length === 0) return out;

  let i = 0;
  for (let g = 0; g < gridTimes.length; g++) {
    const t = gridTimes[g];
    while (i < points.length - 1 && points[i + 1].time <= t) i++;
    const a = points[i];
    const b = points[Math.min(i + 1, points.length - 1)];
    if (t < a.time || t > b.time) continue;
    if (a === b) {
      out[g] = a.frequency;
      continue;
    }
    if (b.time - a.time > VOICED_GAP_TOLERANCE_SECONDS) continue;
    const ratio = (t - a.time) / (b.time - a.time);
    out[g] = a.frequency + (b.frequency - a.frequency) * ratio;
  }
  return out;
}

/**
 * Time-aligns two pitch contours onto a shared 20ms grid and scores how
 * closely the attempt matches the ideal, in semitones (perceptually linear,
 * unlike raw Hz).
 * @param {Array<{time:number, frequency:number}>} idealPoints
 * @param {Array<{time:number, frequency:number}>} attemptPoints
 * @returns {{alignedIdeal: Array<{time:number,pitch:number|null}>, alignedAttempt: Array<{time:number,pitch:number|null}>, divergenceMap: Array<{time:number,semitones:number|null,diverges:boolean|null}>, score: number, duration: number}}
 */
export function computeDivergence(idealPoints, attemptPoints) {
  const idealDuration = idealPoints.length ? idealPoints[idealPoints.length - 1].time : 0;
  const attemptDuration = attemptPoints.length ? attemptPoints[attemptPoints.length - 1].time : 0;
  const duration = Math.max(idealDuration, attemptDuration, GRID_STEP_SECONDS);

  const gridTimes = [];
  for (let t = 0; t <= duration; t += GRID_STEP_SECONDS) gridTimes.push(t);

  const idealHz = resampleLinear(idealPoints, gridTimes);
  const attemptHz = resampleLinear(attemptPoints, gridTimes);

  const alignedIdeal = gridTimes.map((time, i) => ({ time, pitch: idealHz[i] }));
  const alignedAttempt = gridTimes.map((time, i) => ({ time, pitch: attemptHz[i] }));

  // Points where either side is silent/unvoiced don't count toward the score
  // in either direction — there's nothing to meaningfully compare.
  let validCount = 0;
  let withinThreshold = 0;
  const divergenceMap = gridTimes.map((time, i) => {
    const ideal = idealHz[i];
    const attempt = attemptHz[i];
    if (ideal == null || attempt == null) return { time, semitones: null, diverges: null };
    const semitones = 12 * Math.log2(attempt / ideal);
    validCount++;
    const diverges = Math.abs(semitones) > NOTICEABLE_SEMITONES;
    if (!diverges) withinThreshold++;
    return { time, semitones, diverges };
  });

  const score = validCount > 0 ? Math.round((withinThreshold / validCount) * 100) : 0;

  return { alignedIdeal, alignedAttempt, divergenceMap, score, duration };
}

function toDivergenceBands(divergenceMap) {
  const bands = [];
  let start = null;
  for (const point of divergenceMap) {
    if (point.diverges) {
      if (start === null) start = point.time;
    } else if (start !== null) {
      bands.push({ start, end: point.time });
      start = null;
    }
  }
  if (start !== null) {
    bands.push({ start, end: divergenceMap[divergenceMap.length - 1].time + GRID_STEP_SECONDS });
  }
  return bands;
}

// --- Step 4: canvas rendering ----------------------------------------------

function splitIntoVoicedSegments(points) {
  const segments = [];
  let current = [];
  for (let i = 0; i < points.length; i++) {
    if (current.length && points[i].time - points[i - 1].time > VOICED_GAP_TOLERANCE_SECONDS) {
      segments.push(current);
      current = [];
    }
    current.push(points[i]);
  }
  if (current.length) segments.push(current);
  return segments;
}

// Smooths a polyline into a curve using the standard "quadratic through
// midpoints" trick: each original point becomes a control point, and the
// curve passes through the midpoints between consecutive points instead of
// through the raw (jagged) points themselves.
function drawSmoothContour(ctx, points, xScale, yScale, color, dpr) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * dpr;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (const segment of splitIntoVoicedSegments(points)) {
    if (segment.length === 1) {
      const p = segment[0];
      ctx.beginPath();
      ctx.arc(xScale(p.time), yScale(p.frequency), 1.5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      continue;
    }

    const pts = segment.map((p) => [xScale(p.time), yScale(p.frequency)]);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const [cx, cy] = pts[i];
      const [nx, ny] = pts[i + 1];
      ctx.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
    ctx.stroke();
  }
}

function drawDivergenceBands(ctx, bands, xScale, heightPx) {
  ctx.fillStyle = hexToRgba(cssVar("--color-divergence") || "#eb5757", 0.1);
  for (const band of bands) {
    const x0 = xScale(band.start);
    const x1 = xScale(band.end);
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), heightPx);
  }
}

function sizePanel(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const widthCss = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  canvas.width = Math.max(1, Math.round(widthCss * dpr));
  canvas.height = Math.max(1, Math.round(PANEL_HEIGHT_CSS * dpr));
  canvas.style.height = PANEL_HEIGHT_CSS + "px";
  return { widthCss, dpr };
}

// Draws the static base layer (contour + divergence bands, no playhead) for
// both panels into the off-DOM base canvases, then blits them onto the
// visible canvases. Also stashes the xScale so setPlayhead() can composite
// cheaply on every animation frame without recomputing any of this.
function drawBase({ idealPoints, attemptPoints, divergenceMap, duration }) {
  const { widthCss, dpr } = sizePanel(idealCanvas);
  sizePanel(attemptCanvas);
  idealBase.width = idealCanvas.width;
  idealBase.height = idealCanvas.height;
  attemptBase.width = attemptCanvas.width;
  attemptBase.height = attemptCanvas.height;

  const allFreqs = [...idealPoints, ...attemptPoints].map((p) => p.frequency);
  const minHz = allFreqs.length ? Math.min(...allFreqs) * 0.9 : 80;
  const maxHz = allFreqs.length ? Math.max(...allFreqs) * 1.1 : 300;

  const xScale = (t) => (PAD_X_CSS + (t / duration) * (widthCss - 2 * PAD_X_CSS)) * dpr;
  const yScale = (hz) =>
    (PANEL_HEIGHT_CSS - PAD_Y_CSS - ((hz - minHz) / (maxHz - minHz || 1)) * (PANEL_HEIGHT_CSS - 2 * PAD_Y_CSS)) * dpr;

  const idealColor = cssVar("--color-waveform-ideal") || "#e4f222";
  const attemptColor = cssVar("--color-waveform-user") || "#02b8cc";
  const bands = toDivergenceBands(divergenceMap);

  const ictx = idealBase.getContext("2d");
  ictx.clearRect(0, 0, idealBase.width, idealBase.height);
  drawSmoothContour(ictx, idealPoints, xScale, yScale, idealColor, dpr);

  const actx = attemptBase.getContext("2d");
  actx.clearRect(0, 0, attemptBase.width, attemptBase.height);
  drawDivergenceBands(actx, bands, xScale, attemptBase.height);
  drawSmoothContour(actx, attemptPoints, xScale, yScale, attemptColor, dpr);

  currentXScale = xScale;

  compositeFrame(null);
}

function compositeFrame(time) {
  if (!idealCanvas || !attemptCanvas) return;

  const ictx = idealCanvas.getContext("2d");
  ictx.clearRect(0, 0, idealCanvas.width, idealCanvas.height);
  ictx.drawImage(idealBase, 0, 0);

  const actx = attemptCanvas.getContext("2d");
  actx.clearRect(0, 0, attemptCanvas.width, attemptCanvas.height);
  actx.drawImage(attemptBase, 0, 0);

  if (time != null && currentXScale) {
    const x = currentXScale(time);
    const dpr = window.devicePixelRatio || 1;
    const paperColor = cssVar("--color-paper") || "#ffffff";
    for (const ctx of [ictx, actx]) {
      ctx.strokeStyle = paperColor;
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, PANEL_HEIGHT_CSS * dpr);
      ctx.stroke();
    }
  }
}

/**
 * Move the sync playhead to a given time (seconds), or hide it when null.
 * Cheap: just re-composites the cached base images, no re-analysis.
 */
export function setPlayhead(time) {
  compositeFrame(time);
}

function updateBadge(score) {
  if (!badgeEl) return;
  badgeEl.textContent = `${score}% match`;
  badgeEl.hidden = false;
}

function hideBadge() {
  if (badgeEl) badgeEl.hidden = true;
}

function showMessage(text) {
  if (messageEl) {
    messageEl.textContent = text;
    messageEl.hidden = false;
  }
  if (panelsEl) panelsEl.hidden = true;
}

function hideMessage() {
  if (messageEl) messageEl.hidden = true;
}

/**
 * Run the full Step 2-4 pipeline: extract pitch from both clips, compute
 * semitone divergence, and draw the two-panel comparison. Never throws —
 * on failure (bad decode, no voiced signal, etc.) it shows a friendly inline
 * message and leaves the score badge hidden, but never touches audio
 * playback, which callers own independently.
 * @param {{aiUrl: string, userUrl: string}} args
 * @returns {Promise<{score: number}|null>} null on failure
 */
export async function compare({ aiUrl, userUrl }) {
  if (!idealCanvas || !attemptCanvas) return null;

  hideMessage();
  hideBadge();
  if (panelsEl) panelsEl.hidden = false;

  try {
    const [idealPoints, attemptPoints] = await Promise.all([extractPitchContour(aiUrl), extractPitchContour(userUrl)]);

    if (idealPoints.length === 0 || attemptPoints.length === 0) {
      throw new Error("not enough voiced audio");
    }

    const divergence = computeDivergence(idealPoints, attemptPoints);
    drawBase({ idealPoints, attemptPoints, divergenceMap: divergence.divergenceMap, duration: divergence.duration });
    updateBadge(divergence.score);

    return { score: divergence.score };
  } catch {
    showMessage("Couldn't analyze pitch — try recording in a quieter spot.");
    return null;
  }
}

/** Resets the panels/badge/message to their pre-comparison empty state. */
export function reset() {
  currentXScale = null;
  hideBadge();
  hideMessage();
  if (panelsEl) panelsEl.hidden = true;
  if (idealCanvas) idealCanvas.getContext("2d").clearRect(0, 0, idealCanvas.width, idealCanvas.height);
  if (attemptCanvas) attemptCanvas.getContext("2d").clearRect(0, 0, attemptCanvas.width, attemptCanvas.height);
}
