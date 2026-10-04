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

import { extractPitchContour, groupCharactersIntoWords } from "./pitchUtils.js";
import { getScoreTier, generateFeedbackCards, mapWordsToColors } from "./comparisonFeedback.js";

import { computeDivergence, GRID_STEP_SECONDS, VOICED_GAP_TOLERANCE_SECONDS } from "./comparisonMath.js";
export { computeDivergence } from "./comparisonMath.js";


const PANEL_HEIGHT_CSS = 160; // px — matches the spec'd canvas height
const PAD_X_CSS = 4;
const PAD_Y_CSS = 8;
const SCORE_RING_RADIUS = 54; // matches the 120x120 SVG viewBox in index.html
const SCORE_RING_CIRCUMFERENCE = 2 * Math.PI * SCORE_RING_RADIUS;
const SCORE_ANIMATION_MS = 1200;

let idealCanvas = null;
let attemptCanvas = null;
let messageEl = null;
let panelsEl = null;
let resultsEl = null;
let scoreRingEl = null;
let scoreNumberEl = null;
let scoreTierLabelEl = null;
let feedbackCardsEl = null;
let scriptHighlightCardEl = null;
let scriptHighlightWordsEl = null;
let detailToggleBtn = null;
let detailCollapseEl = null;

// Cached off-DOM canvases holding the static contour+band drawing, so the
// playhead can redraw every animation frame by compositing two images
// instead of re-walking every point and re-stroking bezier segments at 60fps.
const idealBase = document.createElement("canvas");
const attemptBase = document.createElement("canvas");

let currentXScale = null; // (seconds) => device px, or null when nothing's drawn
let scoreCountRaf = null;
let lastDrawing = null;
let comparisonRequest = 0;
let resizeObserver;

export function init({
  idealCanvas: ideal,
  attemptCanvas: attempt,
  messageEl: message,
  panelsEl: panels,
  resultsEl: results,
  scoreRingEl: scoreRing,
  scoreNumberEl: scoreNumber,
  scoreTierLabelEl: scoreTierLabel,
  feedbackCardsEl: feedbackCards,
  scriptHighlightCardEl: scriptHighlightCard,
  scriptHighlightWordsEl: scriptHighlightWords,
  detailToggleBtn: detailToggle,
  detailCollapseEl: detailCollapse,
}) {
  idealCanvas = ideal;
  attemptCanvas = attempt;
  messageEl = message;
  panelsEl = panels;
  resultsEl = results;
  scoreRingEl = scoreRing;
  scoreNumberEl = scoreNumber;
  scoreTierLabelEl = scoreTierLabel;
  feedbackCardsEl = feedbackCards;
  scriptHighlightCardEl = scriptHighlightCard;
  scriptHighlightWordsEl = scriptHighlightWords;
  detailToggleBtn = detailToggle;
  detailCollapseEl = detailCollapse;

  if (scoreRingEl) {
    scoreRingEl.style.strokeDasharray = `${SCORE_RING_CIRCUMFERENCE}`;
    scoreRingEl.style.strokeDashoffset = `${SCORE_RING_CIRCUMFERENCE}`;
  }
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => redraw());
  resizeObserver.observe(idealCanvas);
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

export function redraw() {
  if (lastDrawing && idealCanvas?.clientWidth) drawBase(lastDrawing);
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

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

// Ring fill is CSS-driven (a stroke-dashoffset transition) per spec — this
// just sets the target offset, forcing the starting "empty ring" state to
// actually paint first so the browser doesn't coalesce both writes into one
// frame and skip the transition. Only the number counter is JS-driven.
function animateScore(score) {
  if (scoreRingEl) {
    scoreRingEl.style.transition = "none";
    scoreRingEl.style.strokeDashoffset = `${SCORE_RING_CIRCUMFERENCE}`;
    void scoreRingEl.getBoundingClientRect(); // force layout so the reset above actually takes effect
    scoreRingEl.style.transition = "";
    scoreRingEl.style.strokeDashoffset = `${SCORE_RING_CIRCUMFERENCE * (1 - score / 100)}`;
  }

  cancelAnimationFrame(scoreCountRaf);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if (scoreNumberEl) scoreNumberEl.textContent = String(score);
    return;
  }
  const start = performance.now();
  function tick(now) {
    const t = Math.max(0, Math.min(1, (now - start) / SCORE_ANIMATION_MS));
    if (scoreNumberEl) scoreNumberEl.textContent = String(Math.round(easeOutCubic(t) * score));
    if (t < 1) scoreCountRaf = requestAnimationFrame(tick);
  }
  scoreCountRaf = requestAnimationFrame(tick);
}

function renderScoreTier(score) {
  const tier = getScoreTier(score);
  const colorValue = `var(${tier.colorVar})`;
  if (scoreRingEl) scoreRingEl.style.stroke = colorValue;
  if (scoreNumberEl) scoreNumberEl.style.color = colorValue;
  if (scoreTierLabelEl) scoreTierLabelEl.style.color = colorValue;
  if (scoreTierLabelEl) scoreTierLabelEl.textContent = tier.label;
}

function renderFeedbackCards(cards) {
  if (!feedbackCardsEl) return;
  feedbackCardsEl.innerHTML = "";
  for (const { text } of cards) {
    const card = document.createElement("div");
    card.className = "feedback-card";

    const iconEl = document.createElement("span");
    iconEl.className = "feedback-card-icon";
    iconEl.textContent = String(feedbackCardsEl.children.length + 1).padStart(2, '0');
    iconEl.setAttribute('aria-hidden', 'true');

    const textEl = document.createElement("span");
    textEl.className = "feedback-card-text";
    textEl.textContent = text;

    card.append(iconEl, textEl);
    feedbackCardsEl.appendChild(card);
  }
}

// Word colors are applied via inline styles (one <span> per word), not a
// generated CSS class per word, per spec.
function renderScriptHighlight(scriptText, duration, divergenceMap, wordTimings) {
  if (!scriptHighlightCardEl || !scriptHighlightWordsEl) return;
  scriptHighlightCardEl.hidden = false;
  scriptHighlightWordsEl.innerHTML = "";

  const words = mapWordsToColors(scriptText, duration, divergenceMap, wordTimings);
  if (!words) {
    // Too few words for per-word coloring to mean anything — plain text instead.
    scriptHighlightWordsEl.textContent = scriptText;
    scriptHighlightWordsEl.style.color = "var(--color-mist)";
    return;
  }

  scriptHighlightWordsEl.style.color = "";
  words.forEach(({ word, colorVar }, i) => {
    const span = document.createElement("span");
    span.textContent = word;
    if (colorVar) span.style.color = `var(${colorVar})`;
    scriptHighlightWordsEl.appendChild(span);
    if (i < words.length - 1) scriptHighlightWordsEl.appendChild(document.createTextNode(" "));
  });
}

function hideScriptHighlight() {
  if (scriptHighlightCardEl) scriptHighlightCardEl.hidden = true;
}

// Forces the detailed-graphs section back to its default collapsed state —
// called at the start of every compare() (a fresh result always starts
// collapsed) and on reset(). The click-to-expand interaction itself is
// wired in app.js, which holds its own references to these same elements.
function resetDetailToggle() {
  if (detailCollapseEl) {
    detailCollapseEl.style.maxHeight = "";
    detailCollapseEl.classList.remove("detail-collapse-expanded");
  }
  if (detailToggleBtn) {
    detailToggleBtn.textContent = "Explore pitch details +";
    detailToggleBtn.setAttribute("aria-expanded", "false");
  }
}

function showMessage(text) {
  if (messageEl) {
    messageEl.textContent = text;
    messageEl.hidden = false;
  }
  if (panelsEl) panelsEl.hidden = true;
  if (resultsEl) resultsEl.hidden = true;
}

function hideMessage() {
  if (messageEl) messageEl.hidden = true;
}

/**
 * Run the full Step 2-4 pipeline: extract pitch from both clips, compute
 * semitone divergence, draw the two-panel comparison, and render the
 * plain-language feedback layer (score circle, feedback cards, word
 * highlighting) on top of it. Never throws — on failure (bad decode, no
 * voiced signal, etc.) it shows a friendly inline message and hides the
 * whole results section, but never touches audio playback, which callers
 * own independently.
 * @param {{aiUrl: string, userUrl: string, scriptText?: string}} args
 * @returns {Promise<{score: number}|null>} null on failure
 */
export async function compare({ aiUrl, userUrl, scriptText, alignment }) {
  if (!idealCanvas || !attemptCanvas) return null;
  const request = ++comparisonRequest;

  hideMessage();
  resetDetailToggle();
  if (panelsEl) panelsEl.hidden = false;
  if (resultsEl) resultsEl.hidden = true; // stays hidden until there's an actual result to show

  try {
    const [idealPoints, attemptPoints] = await Promise.all([extractPitchContour(aiUrl), extractPitchContour(userUrl)]);
    if (request !== comparisonRequest) return null;

    if (idealPoints.length === 0 || attemptPoints.length === 0) {
      throw new Error("not enough voiced audio");
    }

    const divergence = computeDivergence(idealPoints, attemptPoints);
    if (divergence.score === null) {
      showMessage('There is too little overlapping speech to give a useful pitch score. Start both takes at a similar pace and record the full script.');
      return null;
    }
    lastDrawing = { idealPoints, attemptPoints, divergenceMap: divergence.divergenceMap, duration: divergence.duration };
    drawBase(lastDrawing);

    if (resultsEl) resultsEl.hidden = false;
    renderScoreTier(divergence.score);
    animateScore(divergence.score);
    renderFeedbackCards(generateFeedbackCards(divergence));
    if (scriptText) {
      let wordTimings;
      try { wordTimings = alignment ? groupCharactersIntoWords(alignment) : null; } catch { wordTimings = null; }
      renderScriptHighlight(scriptText, divergence.idealDuration, divergence.divergenceMap, wordTimings);
    } else {
      hideScriptHighlight();
    }

    return { score: divergence.score };
  } catch {
    if (request !== comparisonRequest) return null;
    showMessage("Couldn't analyze pitch — try recording in a quieter spot.");
    return null;
  }
}

/** Resets the results section (score, feedback, highlighting, graphs) and message to their pre-comparison empty state. */
export function reset() {
  comparisonRequest++;
  lastDrawing = null;
  currentXScale = null;
  cancelAnimationFrame(scoreCountRaf);
  hideMessage();
  resetDetailToggle();
  if (resultsEl) resultsEl.hidden = true;
  if (panelsEl) panelsEl.hidden = true;
  if (feedbackCardsEl) feedbackCardsEl.innerHTML = "";
  hideScriptHighlight();
  if (idealCanvas) idealCanvas.getContext("2d").clearRect(0, 0, idealCanvas.width, idealCanvas.height);
  if (attemptCanvas) attemptCanvas.getContext("2d").clearRect(0, 0, attemptCanvas.width, attemptCanvas.height);
}
