import { extractPitchContour, groupCharactersIntoWords } from './pitchUtils.js';
const TREND_THRESHOLD_SEMITONES = 0.4;
function classifyTrend(word, points) {
  const slice = points.filter(point => point.time >= word.start && point.time <= word.end);
  if (slice.length < 4) return 'flat';
  const mid = Math.floor(slice.length / 2);
  const mean = values => values.reduce((sum, p) => sum + p.frequency, 0) / values.length;
  const change = 12 * Math.log2(mean(slice.slice(mid)) / mean(slice.slice(0, mid)));
  return change > TREND_THRESHOLD_SEMITONES ? 'rising' : change < -TREND_THRESHOLD_SEMITONES ? 'falling' : 'flat';
}

export function estimateWordTimings(script, duration) {
  const tokens = String(script || '').trim().split(/\s+/u).filter(Boolean);
  if (!tokens.length || !Number.isFinite(duration) || duration <= 0) return [];
  const weights = tokens.map(token => {
    const spokenLength = token.replace(/[^\p{L}\p{N}]/gu, '').length;
    const pause = /[.!?]["')\]]*$/u.test(token) ? 4 : /[,;:]["')\]]*$/u.test(token) ? 2 : 0;
    return Math.max(1, spokenLength) + pause;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let elapsed = 0;
  return tokens.map((text, index) => {
    const start = elapsed / total * duration;
    elapsed += weights[index];
    return { text, start, end: elapsed / total * duration };
  });
}

export function createReadAlong() {
let container;
let activeWords = [];
let raf;
let version = 0;
let listeners;
function init(el) { container = el; }
function reset() {
  version++;
  cancelAnimationFrame(raf);
  listeners?.abort();
  activeWords = [];
  if (container) {
    container.classList.remove('pitch-viz-ready');
    container.textContent = 'Your words will follow along during playback.';
  }
}
async function render(url, alignment, audio, script = '') {
  reset();
  if (!container) return;
  const request = version;
  container.textContent = 'Preparing your read-along…';
  try {
    const estimated = !alignment;
    let words = alignment
      ? groupCharactersIntoWords(alignment)
      : estimateWordTimings(script, audio.duration);
    const points = await extractPitchContour(url);
    if (request !== version) return;
    // Anchor estimates to this recording's voiced span, never to another
    // provider's timestamps. This is still NOT forced word alignment.
    if (estimated && points.length > 1) {
      const start = points[0].time, span = points.at(-1).time - start;
      words = estimateWordTimings(script, span).map(w => ({ ...w, start: w.start + start, end: w.end + start }));
    }
    if (!words.length) throw new Error('No word timing data');
    container.replaceChildren();
    container.classList.add('pitch-viz-ready');
    listeners = new AbortController();
    const options = { signal: listeners.signal };
    if (estimated) {
      const note = document.createElement('span');
      note.className = 'pitch-viz-estimate-note';
      note.textContent = 'Estimated word timing · Tap a word to replay from there';
      container.append(note);
    }
    activeWords = words.map(word => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `pitch-word trend-${classifyTrend(word, points)}`;
      el.textContent = word.text;
      el.setAttribute('aria-label', `Replay from ${word.text}${estimated ? ' (estimated)' : ''}`);
      el.addEventListener('click', () => { audio.currentTime = word.start; audio.play().catch(() => {}); }, options);
      container.append(el, document.createTextNode(' '));
      return { ...word, el };
    });
    const base = points.length ? points.reduce((sum, p) => sum + Math.log2(p.frequency), 0) / points.length : 0;
    function tick() {
      const point = points[Math.max(0, nearestPoint(points, audio.currentTime))];
      for (const word of activeWords) {
        const active = audio.currentTime >= word.start && audio.currentTime < word.end;
        word.el.classList.toggle('active', active);
        word.el.classList.toggle('spoken', audio.currentTime >= word.end);
        const reliable = point && Math.abs(point.time - audio.currentTime) < 0.12;
        word.el.style.setProperty('--pitch-lift', active && reliable ? `${Math.max(-7, Math.min(7, -12 * (Math.log2(point.frequency) - base)))}px` : '0px');
      }
      if (!audio.paused && !audio.ended) raf = requestAnimationFrame(tick);
    }
    audio.addEventListener('play', () => { cancelAnimationFrame(raf); tick(); }, options);
    audio.addEventListener('pause', () => cancelAnimationFrame(raf), options);
    audio.addEventListener('seeked', () => { cancelAnimationFrame(raf); tick(); }, options);
    audio.addEventListener('ended', () => { cancelAnimationFrame(raf); activeWords.forEach(w => w.el.classList.remove('active')); }, options);
    tick();
  } catch {
    if (request === version) container.textContent = 'Read-along is unavailable for this clip. Playback is ready.';
  }
}
return { init, reset, render };
}
function nearestPoint(points, time) {
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (points[mid].time <= time) lo = mid; else hi = mid - 1; }
  return lo;
}
const referenceView = createReadAlong();
export const init = referenceView.init;
export const reset = referenceView.reset;
export const render = referenceView.render;
