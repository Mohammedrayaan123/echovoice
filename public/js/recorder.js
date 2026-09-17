// recorder.js — wraps the browser's mic-recording API (MediaRecorder).
// Keeps recording concerns out of app.js so app.js only deals with UI wiring.

import { logAudio } from "./audioLog.js";

export class VoiceRecorder {
  /**
   * @param {object} [options]
   * @param {number} [options.minDurationMs] - can't be manually stopped before this;
   *   still auto-stops at maxDurationMs regardless. 0 = no minimum.
   * @param {number} [options.maxDurationMs] - auto-stops recording at this point.
   * @param {"recording"|"guided"|"user-attempt"|null} [options.logType] - when set,
   *   every blob this instance produces is fire-and-forget uploaded to
   *   /save-audio under this type (see audioLog.js). Omit for recorders whose
   *   output shouldn't be logged.
   */
  constructor({ minDurationMs = 0, maxDurationMs = 10_000, logType = null } = {}) {
    this.minDurationMs = minDurationMs;
    this.maxDurationMs = maxDurationMs;
    this.logType = logType;
    this.mediaRecorder = null;
    this.chunks = [];
    this.stream = null;
    this._startedAt = null;
  }

  /**
   * @param {(blob: Blob) => void} [onAutoStop]
   * @param {{deviceId?: string}} [options] - optionally pin a specific input
   *   device (from navigator.mediaDevices.enumerateDevices()); omit for the
   *   browser's default mic.
   */
  async start(onAutoStop, { deviceId } = {}) {
    // Browsers default echoCancellation/noiseSuppression/autoGainControl to true,
    // which processes the signal before we ever see it — subtly altering voice
    // timbre in ways that can hurt clone accuracy. Disabled explicitly for raw,
    // unprocessed capture. Tradeoff: recordings pick up more background noise,
    // so this needs a quiet room.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    this.mediaRecorder = new MediaRecorder(this.stream);
    this.chunks = [];
    this._startedAt = Date.now();

    this.mediaRecorder.addEventListener("dataavailable", (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    });

    this.mediaRecorder.start();

    // Safety net so a demo-day slip (forgetting to click stop) can't ruin the sample.
    this._autoStopTimer = setTimeout(async () => {
      if (this.mediaRecorder.state === "recording") {
        const blob = await this.stop();
        if (onAutoStop) onAutoStop(blob);
      }
    }, this.maxDurationMs);
  }

  // Elapsed recording time in ms — for a live timer/countdown display while recording.
  get elapsedMs() {
    return this._startedAt ? Date.now() - this._startedAt : 0;
  }

  // Whether the minimum duration has been met yet, i.e. whether a manual stop
  // should be allowed right now. Callers decide what to do with this (e.g.
  // disable the Stop button) — this class doesn't block stop() itself.
  get canStopNow() {
    return this.elapsedMs >= this.minDurationMs;
  }

  // The live MediaStream, while recording — lets a caller attach its own
  // AnalyserNode for a waveform display without requesting the mic a second time.
  get liveStream() {
    return this.stream;
  }

  stop() {
    clearTimeout(this._autoStopTimer);
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") {
        resolve(null);
        return;
      }
      this.mediaRecorder.addEventListener("stop", () => {
        // Use whatever format the browser actually recorded (Chrome: webm, Safari: mp4)
        // rather than assuming — a mismatched label breaks decoding on the TTS backend.
        const blob = new Blob(this.chunks, { type: this.mediaRecorder.mimeType });
        this.stream.getTracks().forEach((track) => track.stop());
        // Fire-and-forget copy of the raw input to the server, BEFORE whatever
        // the caller does next (e.g. cloning) — never awaited, never allowed
        // to affect the recording flow. See audioLog.js.
        if (this.logType) logAudio(blob, this.logType);
        resolve(blob);
      });
      this.mediaRecorder.stop();
    });
  }

  get isRecording() {
    return this.mediaRecorder?.state === "recording";
  }
}
