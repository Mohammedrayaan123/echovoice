// Captures microphone audio, balances quiet levels, and owns the stream lifecycle.
import { logAudio } from "./audioLog.js";
import { balanceRecordingLevel } from "./recordingLevel.js";

export class VoiceRecorder {
  constructor({ minDurationMs = 0, maxDurationMs = 10_000, logType = null } = {}) {
    this.minDurationMs = minDurationMs;
    this.maxDurationMs = maxDurationMs;
    this.logType = logType;
    this.mediaRecorder = null;
    this.stream = null;
    this._startedAt = null;
    this._generation = 0;
    this._starting = false;
    this._completion = null;
  }

  async start(onAutoStop, { deviceId } = {}) {
    if (this._starting || this.isRecording) throw new Error("A recording is already in progress.");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new Error("Microphone recording is not supported in this browser. Upload an audio file instead.");
    }
    const generation = ++this._generation;
    this._starting = true;
    this._completion = null;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
          channelCount: { ideal: 1 },
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      });
      // A modal can close while the browser permission prompt is open.
      if (generation !== this._generation) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      this.stream = stream;
      // Safari's native MediaRecorder output is MP4/AAC. Prefer it when the
      // browser exposes it, then use Opus containers elsewhere.
      const formats = ["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus"];
      const mimeType = formats.find((format) => MediaRecorder.isTypeSupported?.(format));
      const baseOptions = mimeType ? { mimeType } : {};
      let recorder;
      try {
        recorder = new MediaRecorder(stream, { ...baseOptions, audioBitsPerSecond: 128000 });
      } catch (error) {
        if (!['NotSupportedError', 'TypeError'].includes(error?.name)) throw error;
        recorder = new MediaRecorder(stream, baseOptions);
      }
      this.mediaRecorder = recorder;
      const chunks = [];
      let failed = false;
      let settled = false;
      let autoStopTimer;
      let finish;
      this._completion = new Promise((resolve) => { finish = resolve; });
      const complete = () => {
        if (settled) return;
        settled = true;
        clearTimeout(autoStopTimer);
        stream.getTracks().forEach((track) => track.stop());
        if (this.stream === stream) this.stream = null;
        const blob = failed || !chunks.length ? null : new Blob(chunks, { type: recorder.mimeType || chunks[0].type });
        balanceRecordingLevel(blob).then((recording) => {
          if (recording && this.logType) logAudio(recording, this.logType);
          finish(recording);
        });
      };
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      recorder.addEventListener("stop", complete, { once: true });
      recorder.addEventListener("error", () => {
        failed = true;
        if (recorder.state !== "inactive") recorder.stop();
        else complete();
        if (generation === this._generation) onAutoStop?.(null);
      }, { once: true });
      // Periodic chunks avoid relying on a single final mobile Safari blob.
      // One second matches WebKit's documented MediaRecorder pattern.
      recorder.start(1000);
      this._startedAt = Date.now();
      autoStopTimer = setTimeout(async () => {
        const blob = await this.stop();
        if (generation === this._generation) onAutoStop?.(blob);
      }, this.maxDurationMs);
      this._autoStopTimer = autoStopTimer;
      return true;
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (generation === this._generation) {
        this.stream = null;
        this.mediaRecorder = null;
        this._completion = null;
      }
      throw error;
    } finally {
      if (generation === this._generation) this._starting = false;
    }
  }

  get elapsedMs() { return this._startedAt === null ? 0 : Date.now() - this._startedAt; }
  get canStopNow() { return this.elapsedMs >= this.minDurationMs; }
  get liveStream() { return this.stream; }
  get isRecording() { return this.mediaRecorder?.state === "recording"; }

  stop() {
    clearTimeout(this._autoStopTimer);
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") this.mediaRecorder.stop();
    return this._completion || Promise.resolve(null);
  }

  // Cancels a pending permission request as well as an active recording.
  cancel() {
    ++this._generation;
    this._starting = false;
    return this.stop();
  }
}
