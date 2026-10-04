import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingGain, levelledWav, balanceRecordingLevel } from '../public/js/recordingLevel.js';
import { analyzePcmChannels } from '../public/js/audioQuality.js';

const sampleRate = 16000;
const tone = (amplitude) => Float32Array.from({ length: sampleRate * 8 }, (_, i) => amplitude * Math.sin(2 * Math.PI * 180 * i / sampleRate));

test('quiet handheld speech is audible and usable without changing pitch or duration', async () => {
  const source = tone(0.008);
  assert.equal(analyzePcmChannels([source], sampleRate).canCreate, false);
  const gain = recordingGain([source]);
  assert.ok(gain > 10 && gain <= 16);
  const output = levelledWav([source], sampleRate, gain);
  assert.equal(output.type, 'audio/wav');
  const view = new DataView(await output.arrayBuffer());
  assert.equal(view.getUint32(24, true), sampleRate);
  assert.equal(view.getUint32(40, true) / 2, source.length);
  const decoded = Float32Array.from(source, (_, i) => view.getInt16(44 + i * 2, true) / 32768);
  const quality = analyzePcmChannels([decoded], sampleRate);
  assert.equal(quality.canCreate, true);
  assert.ok(quality.rmsDb > -25);
  assert.equal(quality.clippingRatio, 0);
  // A constant multiplier preserves the waveform, including zero crossings.
  for (let i = 0; i < source.length; i += 137) assert.ok(Math.abs(decoded[i] - source[i] * gain) < 0.00007);
});

test('silence and healthy audio are untouched; gain is bounded by peaks', () => {
  assert.equal(recordingGain([new Float32Array(1000)]), 1);
  assert.equal(recordingGain([tone(0.0001)]), 1);
  assert.equal(recordingGain([tone(0.15)]), 1);
  const spiky = tone(0.005); spiky[100] = 0.5;
  const gain = recordingGain([spiky]);
  assert.ok(gain <= 0.89 / 0.5);
});

test('WAV gain preserves stereo channels independently, even at opposite phases', async () => {
  const left = tone(0.008), right = Float32Array.from(left, value => -value);
  const gain = recordingGain([left, right]);
  const view = new DataView(await levelledWav([left, right], sampleRate, gain).arrayBuffer());
  assert.equal(view.getUint16(22, true), 2);
  for (let i = 0; i < left.length; i += 137) {
    assert.ok(Math.abs(view.getInt16(44 + i * 4, true) / 32768 - left[i] * gain) < 0.00007);
    assert.ok(Math.abs(view.getInt16(46 + i * 4, true) / 32768 - right[i] * gain) < 0.00007);
  }
});

test('quiet decoded recordings are balanced; decoder failures keep the original clip', async () => {
  const original = new Blob(['encoded recording'], { type: 'audio/mp4' });
  const previous = globalThis.OfflineAudioContext;
  try {
    globalThis.OfflineAudioContext = class {
      async decodeAudioData() { return { numberOfChannels: 1, sampleRate, getChannelData: () => tone(0.008) }; }
    };
    assert.equal((await balanceRecordingLevel(original)).type, 'audio/wav');
    globalThis.OfflineAudioContext = class { async decodeAudioData() { throw new Error('unsupported decoder'); } };
    assert.equal(await balanceRecordingLevel(original), original);
  } finally {
    if (previous) globalThis.OfflineAudioContext = previous;
    else delete globalThis.OfflineAudioContext;
  }
});
