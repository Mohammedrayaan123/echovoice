// Balance quiet microphone recordings with one constant gain. No filtering,
// compression, noise removal, pitch shifting, or silence trimming is applied.
const TARGET_RMS = 0.08; // About -22 dBFS, with room for speech peaks.
const QUIET_RMS = 0.04;
const MAX_GAIN = 16; // +24 dB maximum; never try to recover missing audio.
const PEAK_CEILING = 0.89; // About -1 dBFS.

export function recordingGain(channels) {
  let energy = 0;
  let count = 0;
  let peak = 0;
  for (const channel of channels) {
    for (const sample of channel) {
      if (!Number.isFinite(sample)) return 1;
      energy += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
      count++;
    }
  }
  const rms = count ? Math.sqrt(energy / count) : 0;
  // Leave silence, negligible signals, and healthy recordings alone.
  if (rms < 0.0005 || peak < 0.0035 || rms >= QUIET_RMS) return 1;
  return Math.max(1, Math.min(TARGET_RMS / rms, MAX_GAIN, PEAK_CEILING / peak));
}

export function levelledWav(channels, sampleRate, gain) {
  const frames = channels[0].length;
  const bytes = frames * channels.length * 2;
  const data = new ArrayBuffer(44 + bytes);
  const view = new DataView(data);
  const tag = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  tag(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels.length, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels.length * 2, true);
  view.setUint16(32, channels.length * 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, bytes, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame] * gain));
      view.setInt16(offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      offset += 2;
    }
  }
  return new Blob([data], { type: 'audio/wav' });
}

export async function balanceRecordingLevel(blob) {
  const Context = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!blob?.size || !Context) return blob;
  try {
    const context = new Context(1, 1, 44100);
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
    const gain = recordingGain(channels);
    return gain > 1.05 ? levelledWav(channels, audio.sampleRate, gain) : blob;
  } catch {
    // A browser decoder limitation must not discard a captured recording.
    return blob;
  }
}
