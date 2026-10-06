// A pitch match is a practice aid, not a speaker-identity measurement.
export const GRID_STEP_SECONDS = 0.02;
export const VOICED_GAP_TOLERANCE_SECONDS = 0.12;
export const NOTICEABLE_SEMITONES = 2;
function resample(points, grid) {
  let i = 0;
  return grid.map(time => {
    if (!points.length) return null;
    while (i < points.length - 1 && points[i + 1].time <= time) i++;
    const a = points[i], b = points[Math.min(i + 1, points.length - 1)];
    if (time < a.time || time > b.time || b.time - a.time > VOICED_GAP_TOLERANCE_SECONDS) return null;
    if (a === b) return a.frequency;
    return a.frequency + (b.frequency - a.frequency) * (time - a.time) / (b.time - a.time);
  });
}
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
// Monotonic alignment within 240 ms; skip penalties discourage stretching
// syllables just to improve the score. Pauses are assessed before this warp.
function align(a, b) {
  const band = 12, width = band * 2 + 1, n = a.length;
  const parents = new Uint8Array(n * width);
  let previous = new Float64Array(n).fill(Infinity);
  let row = new Float64Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) {
    // Only the active band is read; clear its boundary too when reusing rows.
    row.fill(Infinity, Math.max(0, i - band - 1), Math.min(n, i + band + 2));
    for (let j = Math.max(0, i - band); j <= Math.min(n - 1, i + band); j++) {
      const cost = a[i] == null || b[j] == null ? (a[i] === b[j] ? 0 : 2) : Math.min(8, Math.abs(a[i] - b[j]));
      const diagonal = i === 0 && j === 0 ? 0 : i && j ? previous[j - 1] : Infinity;
      const up = i ? previous[j] + 0.6 : Infinity, left = j ? row[j - 1] + 0.6 : Infinity;
      const best = Math.min(diagonal, up, left);
      row[j] = cost + best;
      parents[i * width + j - i + band] = best === diagonal ? 1 : best === up ? 2 : 3;
    }
    [previous, row] = [row, previous];
  }
  const matches = new Array(n);
  let i = n - 1, j = n - 1;
  while (i >= 0 && j >= 0) {
    matches[i] = j;
    const direction = parents[i * width + j - i + band];
    if (direction === 1) { i--; j--; }
    else if (direction === 2) i--;
    else if (direction === 3) j--;
    else break;
  }
  return matches;
}
export function computeDivergence(idealPoints, attemptPoints) {
  const clean = points => points.filter(p => Number.isFinite(p.time) && p.time >= 0 && Number.isFinite(p.frequency) && p.frequency > 0).sort((a,b) => a.time - b.time);
  const ideal = clean(idealPoints), attempt = clean(attemptPoints);
  const idealStart = ideal[0]?.time || 0, attemptStart = attempt[0]?.time || 0;
  const idealDuration = (ideal.at(-1)?.time || 0) - idealStart;
  const attemptDuration = (attempt.at(-1)?.time || 0) - attemptStart;
  const ratio = idealDuration ? attemptDuration / idealDuration : 0;
  const duration = Math.max(idealDuration, GRID_STEP_SECONDS);
  if (duration > 180 || attemptDuration > 180) return { score: null, reason: 'too_long' };
  const grid = Array.from({ length: Math.floor(duration / GRID_STEP_SECONDS) + 1 }, (_, i) => i * GRID_STEP_SECONDS);
  const scale = Math.max(0.8, Math.min(1.25, ratio || 1));
  const a = resample(ideal, grid.map(t => t + idealStart));
  const b = resample(attempt, grid.map(t => t * scale + attemptStart));
  const centerA = median(a.filter(v => v != null).map(v => 12 * Math.log2(v)));
  const centerB = median(b.filter(v => v != null).map(v => 12 * Math.log2(v)));
  const relativeA = a.map(v => v == null ? null : 12 * Math.log2(v) - centerA);
  const relativeB = b.map(v => v == null ? null : 12 * Math.log2(v) - centerB);
  const matches = align(relativeA, relativeB);
  let validCount = 0, credit = 0, voicedCount = 0, overlap = 0, referenceVoiced = 0;
  for (let i = 0; i < grid.length; i++) {
    if (a[i] != null) referenceVoiced++;
    if (a[i] != null || b[i] != null) voicedCount++;
    if (a[i] != null && b[i] != null) overlap++;
  }
  const divergenceMap = grid.map((time, i) => {
    time += idealStart;
    const j = matches[i];
    if (relativeA[i] == null || relativeB[j] == null) return { time, semitones: null, diverges: null };
    const semitones = relativeB[j] - relativeA[i];
    const diverges = Math.abs(semitones) > NOTICEABLE_SEMITONES + 1e-9;
    validCount++;
    credit += Math.exp(-((Math.abs(semitones) / 3) ** 2));
    return { time, semitones, diverges };
  });
  const coverage = referenceVoiced ? overlap / referenceVoiced : 0;
  const partial = ratio < 0.7 || ratio > 1.45 || coverage < 0.65;
  const reliable = validCount >= 50 && idealDuration >= 1 && attemptDuration >= 1 && !partial;
  return { alignedIdeal: grid.map((time,i) => ({ time: time + idealStart, pitch: a[i] })),
    alignedAttempt: grid.map((time,i) => ({ time: time + idealStart, pitch: b[matches[i]] == null ? null : b[matches[i]] * 2 ** ((centerA - centerB) / 12) })), divergenceMap,
    score: reliable ? Math.round(credit / validCount * 100) : null, reason: partial ? 'partial' : 'insufficient',
    duration: idealStart + duration, idealDuration, attemptDuration, idealStart, attemptStart, timeScale: scale,
    comparedSeconds: validCount * GRID_STEP_SECONDS, coverage,
    paceDifference: Math.round((ratio - 1) * 100), pauseOverlap: voicedCount ? overlap / voicedCount : 0,
    registerDifference: centerB - centerA,
    flatReference: relativeA.filter(v => v != null).every(v => Math.abs(v) < 0.75) };
}
