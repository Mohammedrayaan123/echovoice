// noiseGate.js — "Remove background noise from recording" enhancement.
//
// Not a spectral denoiser (that needs a real DSP library) — this runs the audio
// through two standard Web Audio nodes: a highpass filter (~80Hz) to cut low-end
// rumble/hum, and a DynamicsCompressorNode to even out levels. Real, audible,
// costs nothing — won't rescue a genuinely noisy recording, but a legitimate
// improvement for a quiet-room recording with some hiss/rumble.

const HIGHPASS_FREQUENCY = 80;

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  function writeStr(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Runs the recording through a highpass filter + compressor and returns the result.
 * @param {Blob} blob - the recorded (or uploaded) audio
 * @returns {Promise<Blob>} a WAV blob with the filter chain applied
 */
export async function applyNoiseGate(blob) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const decodeCtx = new AudioContextClass();

  let audioBuffer;
  try {
    audioBuffer = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    decodeCtx.close();
  }

  const offlineCtx = new OfflineAudioContext(1, audioBuffer.length, audioBuffer.sampleRate);

  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;

  const highpass = offlineCtx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = HIGHPASS_FREQUENCY;

  const compressor = offlineCtx.createDynamicsCompressor();
  // Defaults are Web Audio's own (threshold -24dB, knee 30, ratio 12, attack
  // 0.003s, release 0.25s) — a reasonable general-purpose leveling setting.

  source.connect(highpass);
  highpass.connect(compressor);
  compressor.connect(offlineCtx.destination);

  source.start();
  const rendered = await offlineCtx.startRendering();

  return encodeWav(rendered.getChannelData(0), rendered.sampleRate);
}
