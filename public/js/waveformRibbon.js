// waveformRibbon.js — shared "voice ribbon" canvas drawing: a single
// continuous waveform path mirrored around the vertical center, with a
// subtle gradient fill. One drawing primitive reused everywhere a waveform
// shows up (live recording, frozen AI-playback waveform, small review
// thumbnails, the processing "breathing" loader) so they all read as the
// same visual language instead of three different-looking canvases.
//
// Purely a visual layer — never throws into a caller's recording/playback
// flow; canvas draw calls here are wrapped defensively where they touch
// live audio nodes.

const SAMPLE_STRIDE = 3; // read every 3rd raw sample — reduces jaggedness before smoothing
const SILENCE_AMPLITUDE = 0.015; // below this, render the "collapsed to a line" look instead of raw noise
const SILENCE_JITTER = 0.02;
const DECAY_MS = 500;
const MIN_FRAME_INTERVAL_MS = 30; // caps drawing to ~30fps, per the animation budget

function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function sizeCanvasToCss(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 1;
  const cssHeight = canvas.clientHeight || 1;
  const targetW = Math.max(1, Math.round(cssWidth * dpr));
  const targetH = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  return { cssWidth, cssHeight, dpr };
}

function smoothPathInto(ctx, points) {
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length - 1; i++) {
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    ctx.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2);
  }
  ctx.lineTo(points[points.length - 1][0], points[points.length - 1][1]);
}

/**
 * Draws one "ribbon" frame: `values` (numbers roughly in [-1, 1]) become a
 * waveform mirrored above and below the vertical center, bezier-smoothed,
 * with a translucent gradient fill between the two mirrored curves.
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} values
 * @param {{color?: string, amplitude?: number}} [options]
 */
export function drawRibbon(canvas, values, { color = "#d0d6e0", amplitude = 1 } = {}) {
  const ctx = canvas.getContext("2d");
  const { cssWidth, cssHeight, dpr } = sizeCanvasToCss(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!values || values.length < 2 || cssWidth <= 0) return;

  const midY = (cssHeight / 2) * dpr;
  const halfSpan = midY * 0.9; // small inset so peaks don't touch the canvas edge
  const stepX = (cssWidth * dpr) / (values.length - 1);

  const topPoints = values.map((v, i) => [i * stepX, midY - v * amplitude * halfSpan]);
  const bottomPoints = values.map((v, i) => [i * stepX, midY + v * amplitude * halfSpan]);

  ctx.beginPath();
  smoothPathInto(ctx, topPoints);
  for (let i = bottomPoints.length - 1; i >= 0; i--) ctx.lineTo(bottomPoints[i][0], bottomPoints[i][1]);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, 0, cssHeight * dpr);
  gradient.addColorStop(0, hexToRgba(color, 0.08));
  gradient.addColorStop(1, hexToRgba(color, 0));
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.strokeStyle = hexToRgba(color, 0.8);
  ctx.lineWidth = 1.5 * dpr;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.beginPath();
  smoothPathInto(ctx, topPoints);
  ctx.stroke();

  ctx.beginPath();
  smoothPathInto(ctx, bottomPoints);
  ctx.stroke();
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Live "voice ribbon" driven by a MediaStream's raw time-domain audio (NOT
 * frequency data — that reads as generic equalizer bars, not "what the
 * voice sounds like"). This is purely a visualization tap on the stream via
 * its own AnalyserNode; it never touches MediaRecorder or the stream's
 * getUserMedia constraints.
 * @param {MediaStream} stream
 * @param {HTMLCanvasElement} canvas
 * @param {{color?: string, onLevel?: (level: number) => void}} [options]
 * @returns {{stop: () => void, stopImmediately: () => void}}
 */
export function startLiveRibbon(stream, canvas, { color = "#d0d6e0", onLevel } = {}) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioContextClass();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const timeData = new Uint8Array(analyser.fftSize);

  let raf;
  let lastDraw = 0;
  let decayStart = null;
  let torn = false;

  function teardown() {
    if (torn) return;
    torn = true;
    cancelAnimationFrame(raf);
    try {
      source.disconnect();
      audioCtx.close();
    } catch {
      // Already torn down — fine.
    }
  }

  function frame(ts) {
    if (torn) return;
    raf = requestAnimationFrame(frame);
    if (ts - lastDraw < MIN_FRAME_INTERVAL_MS) return;
    lastDraw = ts;

    analyser.getByteTimeDomainData(timeData);
    const values = [];
    let peak = 0;
    for (let i = 0; i < timeData.length; i += SAMPLE_STRIDE) {
      const v = (timeData[i] - 128) / 128;
      peak = Math.max(peak, Math.abs(v));
      values.push(v);
    }
    if (onLevel) onLevel(peak);

    // Silence collapses to a thin, gently jittering line rather than a dead-
    // flat one — a real, if near-silent, signal instead of a jarring snap.
    const renderValues = peak < SILENCE_AMPLITUDE ? values.map(() => (Math.random() - 0.5) * SILENCE_JITTER) : values;

    let amplitude = 1;
    if (decayStart != null) {
      const t = Math.min(1, (performance.now() - decayStart) / DECAY_MS);
      amplitude = 1 - easeOutCubic(t);
    }

    drawRibbon(canvas, renderValues, { color, amplitude });

    if (decayStart != null && performance.now() - decayStart >= DECAY_MS) teardown();
  }
  raf = requestAnimationFrame(frame);

  return {
    // Graceful stop: decays the amplitude to 0 over ~500ms (matching the
    // canvas's own opacity fade-out, driven by the caller via CSS) instead
    // of snap-cutting the waveform.
    stop() {
      if (decayStart == null) decayStart = performance.now();
    },
    // Immediate teardown — for cleanup paths (e.g. the modal closing mid-recording)
    // where there's no visible canvas left to animate anyway.
    stopImmediately: teardown,
  };
}

/**
 * Downsamples a decoded AudioBuffer's first channel into `bucketCount` peak
 * values in [0, 1], for a frozen/static ribbon (AI playback waveform, a
 * review-step thumbnail).
 * @param {AudioBuffer} audioBuffer
 * @param {number} bucketCount
 * @returns {number[]}
 */
export function sampleAudioBufferPeaks(audioBuffer, bucketCount) {
  const channelData = audioBuffer.getChannelData(0);
  const bucketSize = Math.max(1, Math.floor(channelData.length / bucketCount));
  const values = [];
  for (let i = 0; i < bucketCount; i++) {
    const start = i * bucketSize;
    const end = Math.min(channelData.length, start + bucketSize);
    let peak = 0;
    for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(channelData[j]));
    values.push(peak);
  }
  return values;
}

/** Decodes a blob/object URL to an AudioBuffer (decode-only; no playback). */
export async function decodeAudioBufferFromUrl(url) {
  const arrayBuffer = await (await fetch(url)).arrayBuffer();
  const offlineCtx = new OfflineAudioContext(1, 1, 44100);
  return offlineCtx.decodeAudioData(arrayBuffer);
}

/**
 * The "processing" loading animation: a mostly-flat line with a gentle
 * traveling ripple whose amplitude swells and fades on a slow, repeating
 * heartbeat-like envelope — signals "working" without a generic spinner.
 * @param {HTMLCanvasElement} canvas
 * @param {{color?: string}} [options]
 * @returns {() => void} stop function
 */
export function startBreathingLoader(canvas, { color = "#e4f222" } = {}) {
  const PERIOD_S = 2.2;
  const start = performance.now();
  let raf;
  let lastDraw = 0;
  let stopped = false;

  function frame(ts) {
    if (stopped) return;
    raf = requestAnimationFrame(frame);
    if (ts - lastDraw < MIN_FRAME_INTERVAL_MS) return;
    lastDraw = ts;

    const { cssWidth, cssHeight, dpr } = sizeCanvasToCss(canvas);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (cssWidth <= 0) return;

    const t = (performance.now() - start) / 1000;
    // sin^6 of a slow phase = a narrow repeating pulse separated by flat
    // troughs — the "heartbeat-flat-heartbeat" envelope.
    const envelope = Math.pow(Math.max(0, Math.sin((t / PERIOD_S) * Math.PI)), 6);
    const midY = (cssHeight / 2) * dpr;
    const n = 100;
    const points = [];
    for (let i = 0; i < n; i++) {
      const xi = i / (n - 1);
      const y = midY - Math.sin(xi * Math.PI * 3 + t * 2) * envelope * midY * 0.5;
      points.push([xi * cssWidth * dpr, y]);
    }

    ctx.strokeStyle = hexToRgba(color, 0.4);
    ctx.lineWidth = 1.5 * dpr;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    smoothPathInto(ctx, points);
    ctx.stroke();
  }
  raf = requestAnimationFrame(frame);

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}

/**
 * Keeps a canvas's backing resolution in sync with its CSS box size (instead
 * of a hardcoded pixel width) and re-invokes `onResize` after a resize so
 * static (non-animating) ribbons can redraw at the new size.
 * @param {HTMLCanvasElement} canvas
 * @param {() => void} onResize
 * @returns {() => void} disconnect function
 */
export function observeCanvasResize(canvas, onResize) {
  const observer = new ResizeObserver(() => onResize());
  observer.observe(canvas);
  return () => observer.disconnect();
}
