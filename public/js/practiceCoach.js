import { PitchDetector } from '../vendor/pitchy.js';
import { estimateWordTimings } from './pitchViz.js';

// Analysis tap only: never connects to speakers or changes captured audio.
export function startPracticeCoach(stream, { canvas, label, meter, scriptElement, duration, guided }) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextClass();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  context.resume().catch(() => {});
  const detector = PitchDetector.forFloat32Array(2048);
  const samples = new Float32Array(2048);
  const original = scriptElement.textContent;
  const words = guided ? estimateWordTimings(original, duration) : [];
  const elements = words.map(word => {
    const el = document.createElement('span');
    el.className = 'pitch-word'; el.textContent = word.text;
    return el;
  });
  if (elements.length) scriptElement.replaceChildren(...elements.flatMap(el => [el, document.createTextNode(' ')]));
  let raf, lastDraw = 0, speechStart = null, stopped = false;
  const history = [];
  function tick(now) {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    if (now - lastDraw < 60) return;
    lastDraw = now;
    analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
    meter.value = Math.min(1, rms / 0.15);
    const [hz, clarity] = detector.findPitch(samples, context.sampleRate);
    const voiced = rms > 0.003 && clarity >= 0.8 && hz >= 60 && hz <= 500;
    if (voiced && speechStart == null) speechStart = now;
    history.push(voiced ? 12 * Math.log2(hz) : null);
    if (history.length > 100) history.shift();
    label.textContent = voiced ? `Live pitch · ${Math.round(hz)} Hz${guided ? ' · Following reference pace (guide only)' : ''}` : rms < 0.003 ? 'Listening · Speak at a comfortable volume' : 'Listening · No clear pitch at this moment';
    const values = history.filter(v => v != null);
    const center = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const cssWidth = canvas.clientWidth || 300, cssHeight = 84;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(cssWidth * dpr)) canvas.width = Math.round(cssWidth * dpr);
    if (canvas.height !== cssHeight * dpr) canvas.height = cssHeight * dpr;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#a9d9d1'; ctx.lineWidth = 2 * dpr; ctx.beginPath();
    let connected = false;
    history.forEach((value, index) => {
      if (value == null) { connected = false; return; }
      const x = index / 99 * canvas.width, y = canvas.height / 2 - Math.max(-12, Math.min(12, value - center)) / 24 * canvas.height;
      if (connected) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      connected = true;
    });
    ctx.stroke();
    const elapsed = speechStart == null ? -1 : (now - speechStart) / 1000;
    words.forEach((word, index) => {
      const active = elapsed >= word.start && elapsed < word.end;
      elements[index].classList.toggle('active', active);
      elements[index].classList.toggle('spoken', elapsed >= word.end);
      elements[index].style.setProperty('--pitch-lift', active && voiced ? `${Math.max(-7, Math.min(7, -(12 * Math.log2(hz) - center)))}px` : '0px');
    });
  }
  raf = requestAnimationFrame(tick);
  return () => {
    stopped = true; cancelAnimationFrame(raf); source.disconnect(); context.close().catch(() => {});
    scriptElement.textContent = original;
    meter.value = 0; label.textContent = 'Take finished. Play it back to follow your words.';
  };
}
