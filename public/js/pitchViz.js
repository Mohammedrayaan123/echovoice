import { extractPitchContour, groupCharactersIntoWords } from './pitchUtils.js';
const TREND_THRESHOLD_SEMITONES = 0.4;
let container;
let activeWords = [];
let raf;
let version = 0;
let listeners;
export function init(el) { container = el; }
export function reset() {
  version++;
  cancelAnimationFrame(raf);
  listeners?.abort();
  activeWords = [];
  if (container) {
    container.classList.remove('pitch-viz-ready');
    container.textContent = 'Your script will follow along as your reference plays.';
  }
}
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

export async function render(url, alignment, audio, script = '') {
  reset();
  if (!container) return;
  const request = version;
  container.textContent = 'Preparing your read-along…';
  try {
    const estimated = !alignment;
    const words = alignment
      ? groupCharactersIntoWords(alignment)
      : estimateWordTimings(script, audio.duration);
    if (!words.length) throw new Error('No word timing data');
    const points = await extractPitchContour(url);
    if (request !== version) return;
    container.replaceChildren();
    container.classList.add('pitch-viz-ready');
    if (estimated) {
      const note = document.createElement('span');
      note.className = 'pitch-viz-estimate-note';
      note.textContent = 'Estimated timing';
      container.append(note);
    }
    activeWords = words.map(word => {
      const el = document.createElement('span');
      el.className = `pitch-word trend-${classifyTrend(word, points)}`;
      el.textContent = word.text;
      container.append(el, document.createTextNode(' '));
      return { ...word, el };
    });
    function tick() {
      for (const word of activeWords) word.el.classList.toggle('active', audio.currentTime >= word.start && audio.currentTime < word.end);
      if (!audio.paused && !audio.ended) raf = requestAnimationFrame(tick);
    }
    listeners = new AbortController();
    const options = { signal: listeners.signal };
    audio.addEventListener('play', () => { cancelAnimationFrame(raf); tick(); }, options);
    audio.addEventListener('pause', () => cancelAnimationFrame(raf), options);
    audio.addEventListener('seeked', () => { cancelAnimationFrame(raf); tick(); }, options);
    audio.addEventListener('ended', () => { cancelAnimationFrame(raf); activeWords.forEach(w => w.el.classList.remove('active')); }, options);
    tick();
  } catch {
    if (request === version) container.textContent = 'Read-along is unavailable for this clip. Playback is ready.';
  }
}
