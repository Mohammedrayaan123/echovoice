// Checks the original decoded signal without changing it. These measurements
// cannot identify a speaker, detect background noise, or verify clone likeness.
// OmniVoice recommends a short, exact reference. Long prompts can preserve
// timbre while degrading the generated words, so keep clone input compact.
export const MIN_SAMPLE_SECONDS = 7;
export const MAX_SAMPLE_SECONDS = 10;

export function analyzePcmChannels(channels, sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !channels?.length || !channels[0]?.length) throw new Error("Audio has no usable samples.");
  const length = channels[0].length;
  if (channels.some((channel) => channel.length !== length)) throw new Error("Audio channels have different lengths.");
  const frameSize = Math.max(1, Math.round(sampleRate * 0.02));
  let energy = 0;
  let clippedSamples = 0;
  let activeSamples = 0;
  let peak = 0;
  for (let offset = 0; offset < length; offset += frameSize) {
    let frameEnergy = 0;
    const end = Math.min(length, offset + frameSize);
    for (const channel of channels) {
      for (let i = offset; i < end; i++) {
        const value = channel[i];
        if (!Number.isFinite(value)) throw new Error("Audio contains invalid samples.");
        const magnitude = Math.abs(value);
        frameEnergy += value * value;
        if (magnitude >= 0.99) clippedSamples++;
        peak = Math.max(peak, magnitude);
      }
    }
    energy += frameEnergy;
    // Average channel energies, not the signals: opposite stereo phases must
    // not turn audible recordings into an apparent silent sample.
    if (Math.sqrt(frameEnergy / ((end - offset) * channels.length)) >= 0.008) activeSamples += end - offset;
  }
  const durationSeconds = length / sampleRate;
  const rms = Math.sqrt(energy / (length * channels.length));
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  const clippingRatio = clippedSamples / (length * channels.length);
  const activeSeconds = activeSamples / sampleRate;
  const quietRatio = 1 - activeSamples / length;
  const issues = [];
  const add = (code, severity, message) => issues.push({ code, severity, message });
  // Codec boundaries can differ slightly from the recorder's wall clock.
  if (durationSeconds < MIN_SAMPLE_SECONDS - 0.5) add("too_short", "error", "Record at least 7 seconds so the voice reference contains a complete sentence.");
  if (durationSeconds > MAX_SAMPLE_SECONDS + 0.5) add("too_long", "error", "Use a clean reference no longer than 10 seconds. Longer samples can reduce word accuracy.");
  if (rmsDb < -48 || peak < 0.005) {
    add("silent", "error", "This sample is silent or too quiet to use. Check your microphone and record again.");
  } else if (rmsDb < -36) {
    add("quiet", "warning", "Your recording is quiet. Move a little closer to the microphone and consider recording again.");
  }
  if (rmsDb >= -48 && (quietRatio > 0.65 || activeSeconds < 4)) add("long_pauses", "error", "Too much of this sample is quiet. Read the full sentence naturally with only brief pauses.");
  if (clippingRatio >= 0.01) {
    add("clipping", "error", "The recording is overloaded and may sound distorted. Lower your microphone gain or move farther away, then record again.");
  } else if (clippingRatio >= 0.001) {
    add("clipping", "warning", "Some peaks may be distorted. Listen carefully; lower your microphone gain if you hear crackling.");
  }
  return { durationSeconds, rmsDb, peak, clippingRatio, quietRatio, activeSeconds, issues, canCreate: !issues.some((issue) => issue.severity === "error") };
}

export function analyzeAudioBuffer(buffer) {
  return analyzePcmChannels(Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index)), buffer.sampleRate);
}
