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
export function computeDivergence(idealPoints, attemptPoints) {
  const clean = points => points.filter(p => Number.isFinite(p.time) && p.time >= 0 && Number.isFinite(p.frequency) && p.frequency > 0).sort((a,b) => a.time - b.time);
  const ideal = clean(idealPoints), attempt = clean(attemptPoints);
  const idealDuration = ideal.at(-1)?.time || 0;
  const attemptDuration = attempt.at(-1)?.time || 0;
  const duration = Math.max(idealDuration, attemptDuration, GRID_STEP_SECONDS);
  const grid = Array.from({ length: Math.floor(duration / GRID_STEP_SECONDS) + 1 }, (_, i) => i * GRID_STEP_SECONDS);
  const a = resample(ideal, grid), b = resample(attempt, grid);
  let validCount = 0, matched = 0, voicedCount = 0;
  const divergenceMap = grid.map((time, i) => {
    if (a[i] !== null || b[i] !== null) voicedCount++;
    if (a[i] === null || b[i] === null) return { time, semitones: null, diverges: null };
    const semitones = 12 * Math.log2(b[i] / a[i]);
    const diverges = Math.abs(semitones) > NOTICEABLE_SEMITONES + 1e-9;
    validCount++;
    if (!diverges) matched++;
    return { time, semitones, diverges };
  });
  const coverage = voicedCount ? validCount / voicedCount : 0;
  const reliable = validCount >= 25 && coverage >= 0.15;
  return { alignedIdeal: grid.map((time,i) => ({ time, pitch: a[i] })), alignedAttempt: grid.map((time,i) => ({ time, pitch: b[i] })), divergenceMap,
    score: reliable ? Math.round(matched / validCount * 100) : null, duration, idealDuration, attemptDuration, comparedSeconds: validCount * GRID_STEP_SECONDS, coverage };
}
