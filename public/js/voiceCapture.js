// voiceCapture.js — the voice-cloning onboarding modal, styled to match
// ElevenLabs' own onboarding flow: 5 steps (Upload/Record -> Active Recording
// -> Review & Metadata -> Verification (optional) -> Completion). Owns its own
// modal DOM (appended once to document.body) and a small state machine;
// renders a compact trigger into the container passed to init() for the rest
// of the page. Calls onVoiceReady(voiceId) once a usable voice exists — from
// completing the wizard, skipping verification, or pasting an existing
// ElevenLabs voice_id.
//
// Step 4 (Verification) is a LOCAL sanity check only — it never sends audio
// to ElevenLabs. It checks that the verification recording (a) matches a
// prompted sentence via SpeechRecognition, and (b) has a similar average
// pitch to the Step-2/3 sample via Pitchy. Both generous on purpose: a false
// failure here is worse than a false pass for a demo tool.
//
// The audio capture path (getUserMedia constraints, raw blob handling, what
// gets sent to ElevenLabs) is untouched by this file's UI rebuild — see
// recorder.js and runCloning() below. The noise-removal checkbox is cosmetic
// only; ElevenLabs does its own audio processing internally.

import { VoiceRecorder } from "./recorder.js";
import { createVoiceProfile, synthesizeSpeech } from "./tts.js";
import { extractPitchContour } from "./pitchUtils.js";
import { pickSentence, wordOverlapRatio, transcribeLive, isSpeechRecognitionSupported } from "./speechMatch.js";
import { friendlyErrorMessage } from "./errorMessages.js";
import { startLiveRibbon, sampleAudioBufferPeaks, decodeAudioBufferFromUrl, drawRibbon } from "./waveformRibbon.js";

const TOTAL_STEPS = 5;
const STAGE1_MIN_MS = 10_000;
const STAGE1_MAX_MS = 30_000;
const VERIFY_MAX_MS = 15_000;
const MAX_VERIFY_ATTEMPTS = 3;
const TEXT_MATCH_THRESHOLD = 0.7; // 70%+ word overlap counts as a match
const PITCH_MAX_RELATIVE_DIFF = 0.4; // verify F0 within 40% of the main sample's F0
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const QUIET_LEVEL_THRESHOLD = 0.02; // rough 0-1 level below which we call it "too quiet"
const QUIET_WARNING_MS = 3000;
const RING_RADIUS = 24;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
// How far from a recorder's own max duration the timer turns --color-error.
// Proportional to each recorder's cap rather than a fixed "75s of a 90s cap"
// (the spec's example number) — this app's two recorders cap at 30s and 15s.
const TIMER_WARNING_WINDOW_MS = 5000;

const STORAGE_KEY_VOICE_ID = "echovoice.voiceId";

const LANGUAGES = [
  { code: "en-US", label: "English" },
  { code: "ar-SA", label: "Arabic" },
  { code: "es-ES", label: "Spanish" },
  { code: "fr-FR", label: "French" },
  { code: "de-DE", label: "German" },
  { code: "hi-IN", label: "Hindi" },
  { code: "pt-BR", label: "Portuguese" },
  { code: "ja-JP", label: "Japanese" },
  { code: "zh-CN", label: "Chinese" },
  { code: "ru-RU", label: "Russian" },
];

const SAMPLE_PARAGRAPH =
  "This is a quick preview of your cloned voice. Once you're happy with how it sounds, you can use it to rehearse anything you want to say.";

const FAIL_MESSAGES = {
  text: "Voice verification attempt failed. Spoken text doesn't match the presented text.",
  voice: "Voice verification attempt failed. Your recording doesn't match the voice from your uploaded samples.",
};

let triggerContainer = null;
let onVoiceReadyCallback = null;
let modalOverlay = null;
let modalBody = null;

const mainRecorder = new VoiceRecorder({ minDurationMs: STAGE1_MIN_MS, maxDurationMs: STAGE1_MAX_MS, logType: "recording" });
const verifyRecorder = new VoiceRecorder({ minDurationMs: 0, maxDurationMs: VERIFY_MAX_MS, logType: "guided" });

const state = {
  modalOpen: false,
  step: 1,
  audioBlob: null,
  audioUrl: null,
  audioSource: "record", // "record" | "upload"
  fileName: null,
  removeNoise: false, // cosmetic only — never applied to the audio
  voiceName: "My Voice",
  language: "en-US",
  legalConfirmed: false,
  voiceId: null,
  attempt: 0,
  currentSentence: null,
  verifyPassed: null,
  failureReason: null,
  exhausted: false,
  error: null,
};

// Tracked so closeModal()/navigating away mid-recording can always clean up,
// regardless of which step/phase is currently active.
let activeIntervalHandle = null;
let activeWaveformStop = null;
let activeVerifyCancel = null;
let activeAudioPreviewStop = null;

// ---------- tiny utilities ----------

function qs(sel) {
  return modalBody.querySelector(sel);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function updateTimerLabel(timerEl, elapsedMs, maxMs) {
  timerEl.textContent = `${formatTime(elapsedMs)} / ${formatTime(maxMs)}`;
  timerEl.classList.toggle("vc-timer-warning", maxMs - elapsedMs <= TIMER_WARNING_WINDOW_MS);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function persistVoiceId(voiceId) {
  try {
    localStorage.setItem(STORAGE_KEY_VOICE_ID, voiceId);
  } catch {
    // Best-effort.
  }
}

function clearPersistedVoiceId() {
  try {
    localStorage.removeItem(STORAGE_KEY_VOICE_ID);
  } catch {
    // Best-effort.
  }
}

function readPersistedVoiceId() {
  try {
    return localStorage.getItem(STORAGE_KEY_VOICE_ID) || "";
  } catch {
    return "";
  }
}

// ---------- audio helpers ----------

function average(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

async function pitchProfileOf(urlOrBlob) {
  const url = urlOrBlob instanceof Blob ? URL.createObjectURL(urlOrBlob) : urlOrBlob;
  try {
    const points = await extractPitchContour(url);
    if (points.length === 0) return null;
    return average(points.map((p) => p.frequency));
  } finally {
    if (urlOrBlob instanceof Blob) URL.revokeObjectURL(url);
  }
}

// Generous on purpose — false failures are worse than false passes here.
async function checkVoiceSimilarity(mainUrl, verifyBlob) {
  const [mainF0, verifyF0] = await Promise.all([pitchProfileOf(mainUrl), pitchProfileOf(verifyBlob)]);
  if (mainF0 == null || verifyF0 == null) return true; // can't measure — don't fail them for that
  const relativeDiff = Math.abs(verifyF0 - mainF0) / mainF0;
  return relativeDiff <= PITCH_MAX_RELATIVE_DIFF;
}

// Live "voice ribbon" (time-domain waveform, not frequency bars) — see
// waveformRibbon.js. Handles the canvas's own entrance fade-in (opacity
// 0->1) and, on stop, its exit fade-out timed to match the amplitude decay
// startLiveRibbon() already runs internally. Also feeds onLevel(0-1) so
// callers can do "too quiet for too long" detection off the same analyser
// instead of standing up a second one.
function startWaveform(stream, canvas, onLevel) {
  canvas.classList.add("vc-waveform-visible");
  const ribbon = startLiveRibbon(stream, canvas, { color: "#d0d6e0", onLevel }); // --color-mist

  return () => {
    canvas.classList.remove("vc-waveform-visible");
    ribbon.stop();
  };
}

// The waveform is cosmetic — a failure here (e.g. an unusual stream state)
// must never abort the actual recording/verification.
function safeStartWaveform(stream, canvas, onLevel) {
  try {
    return startWaveform(stream, canvas, onLevel);
  } catch {
    return () => {};
  }
}

// Draws a one-time frozen waveform thumbnail for the Step 3 review card, from
// the already-recorded/uploaded audio. Cosmetic and best-effort — a decode
// failure (e.g. an unusual upload container) just leaves the canvas blank.
async function drawThumbnailWaveform(url, canvas) {
  try {
    const buffer = await decodeAudioBufferFromUrl(url);
    const peaks = sampleAudioBufferPeaks(buffer, 100);
    drawRibbon(canvas, peaks, { color: "#d0d6e0" }); // --color-mist
  } catch {
    // Cosmetic only — the play/pause + duration UI still works without it.
  }
}

// Shares one warning line between two purposes: "too quiet for 3+ seconds"
// (from live level data) and a transient "you can't stop yet" message (which
// would otherwise get overwritten by the very next animation frame's quiet
// check) — showOverride() blocks the quiet-check from stomping on it briefly.
function createWarningController(el) {
  let quietSince = null;
  let overrideUntil = 0;

  return {
    onLevel(level) {
      if (!el || Date.now() < overrideUntil) return;
      const now = performance.now();
      if (level < QUIET_LEVEL_THRESHOLD) {
        if (quietSince == null) quietSince = now;
        if (now - quietSince >= QUIET_WARNING_MS) {
          el.textContent = "It's quite quiet — check your mic isn't muted or move closer.";
        }
      } else {
        quietSince = null;
        el.textContent = "";
      }
    },
    showOverride(text, durationMs = 2500) {
      if (!el) return;
      el.textContent = text;
      overrideUntil = Date.now() + durationMs;
    },
  };
}

// Drives the circular progress ring around the review-step play button.
function setupPlayPauseWithRing(url, btn, ringFg, durationLabel) {
  const audio = new Audio(url);
  ringFg.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;
  ringFg.style.strokeDashoffset = `${RING_CIRCUMFERENCE}`;

  audio.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(audio.duration)) durationLabel.textContent = formatTime(audio.duration * 1000);
  });
  audio.addEventListener("timeupdate", () => {
    if (!Number.isFinite(audio.duration) || audio.duration === 0) return;
    const progress = audio.currentTime / audio.duration;
    ringFg.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - progress)}`;
  });
  audio.addEventListener("ended", () => {
    btn.textContent = "▶";
    ringFg.style.strokeDashoffset = `${RING_CIRCUMFERENCE}`;
  });
  btn.addEventListener("click", () => {
    if (audio.paused) {
      // An unusual upload (e.g. a video container this browser won't play as
      // audio) can make play() reject — catch it so the button doesn't get
      // stuck showing "pause" for audio that never actually started.
      audio.play().catch(() => {
        btn.textContent = "▶";
      });
      btn.textContent = "⏸";
    } else {
      audio.pause();
      btn.textContent = "▶";
    }
  });

  return () => audio.pause();
}

// ---------- modal chrome (created once, not re-rendered per step) ----------

function createModalDom() {
  modalOverlay = document.createElement("div");
  modalOverlay.className = "vc-overlay";
  modalOverlay.hidden = true;
  modalOverlay.innerHTML = `
    <div class="vc-modal" role="dialog" aria-modal="true" aria-label="Clone your voice">
      <button class="vc-close-btn" id="vc-close-btn" aria-label="Close" type="button">&times;</button>
      <div id="vc-modal-body"></div>
    </div>
  `;
  document.body.appendChild(modalOverlay);
  modalBody = modalOverlay.querySelector("#vc-modal-body");

  modalOverlay.querySelector("#vc-close-btn").addEventListener("click", closeModal);
  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeModal();
  });
}

function progressHtml() {
  let segs = "";
  for (let i = 1; i <= TOTAL_STEPS; i++) {
    const cls = i < state.step ? "vc-done" : i === state.step ? "vc-current" : "";
    segs += `<div class="vc-progress-seg ${cls}"></div>`;
  }
  return `<div class="vc-progress">${segs}</div><p class="vc-progress-label">Step ${state.step} of ${TOTAL_STEPS}</p>`;
}

function setStepHtml(bodyHtml) {
  modalBody.innerHTML = progressHtml() + `<div class="vc-step">${bodyHtml}</div>`;
}

function stopAnyActiveCapture() {
  clearInterval(activeIntervalHandle);
  activeIntervalHandle = null;
  if (activeWaveformStop) {
    activeWaveformStop();
    activeWaveformStop = null;
  }
  if (activeAudioPreviewStop) {
    activeAudioPreviewStop();
    activeAudioPreviewStop = null;
  }
  if (activeVerifyCancel) {
    activeVerifyCancel();
    activeVerifyCancel = null;
  } else {
    if (mainRecorder.isRecording) mainRecorder.stop();
    if (verifyRecorder.isRecording) verifyRecorder.stop();
  }
}

export function openModal() {
  stopAnyActiveCapture();
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.step = 1;
  state.audioBlob = null;
  state.audioUrl = null;
  state.fileName = null;
  state.voiceName = "My Voice";
  state.language = "en-US";
  state.removeNoise = false;
  state.legalConfirmed = false;
  state.attempt = 0;
  state.verifyPassed = null;
  state.error = null;
  state.modalOpen = true;

  modalOverlay.hidden = false;
  // setTimeout, not requestAnimationFrame — this only needs "next tick, after
  // the browser has registered hidden=false" for the CSS transition to catch,
  // not frame-syncing, and rAF can be throttled/suspended in ways a plain
  // timer isn't (e.g. a backgrounded tab), which would silently skip the fade-in.
  setTimeout(() => modalOverlay.classList.add("vc-open"), 0);
  renderStep1();
}

function closeModal() {
  stopAnyActiveCapture();
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.modalOpen = false;
  state.audioBlob = null;
  state.audioUrl = null;
  modalOverlay.classList.remove("vc-open");
  setTimeout(() => {
    if (!state.modalOpen) modalOverlay.hidden = true;
  }, 220);
}

// ---------- Step 1: Upload / Record selection ----------

function renderStep1() {
  state.step = 1;
  setStepHtml(`
    <h2 class="vc-title vc-centered">Instant Voice Clone</h2>
    <div class="vc-dropzone" id="vc-dropzone" tabindex="0" role="button" aria-label="Upload audio or video">
      <span class="vc-dropzone-icon">☁️</span>
      <p class="vc-dropzone-text">Drag &amp; drop audio or video files up to 10MB each</p>
      <div class="vc-divider"><span>or</span></div>
      <div class="vc-record-trigger-wrap">
        <button type="button" id="vc-record-btn" class="vc-record-trigger" aria-label="Record audio">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"></path>
            <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V21a1 1 0 1 0 2 0v-3.08A7 7 0 0 0 19 11z"></path>
          </svg>
        </button>
        <p class="vc-record-trigger-label">Record audio</p>
      </div>
      <div class="vc-device-dropdown" id="vc-device-dropdown" hidden></div>
    </div>
    <input type="file" id="vc-file-input" accept="audio/*,video/*" hidden />
    <div class="vc-tip-cards">
      <div class="vc-tip-card">
        <span class="vc-tip-icon">🔇</span>
        <div><div class="vc-tip-title">Avoid noisy environments</div><div class="vc-tip-desc">Background sounds interfere with recording quality</div></div>
      </div>
      <div class="vc-tip-card">
        <span class="vc-tip-icon">🎙️</span>
        <div><div class="vc-tip-title">Check microphone quality</div><div class="vc-tip-desc">Try external units or headphone mics for better capture</div></div>
      </div>
      <div class="vc-tip-card">
        <span class="vc-tip-icon">🔄</span>
        <div><div class="vc-tip-title">Use consistent equipment</div><div class="vc-tip-desc">Don't change recording equipment between samples</div></div>
      </div>
    </div>
    <p class="status">${state.error ? escapeHtml(state.error) : ""}</p>
  `);

  const dropzone = qs("#vc-dropzone");
  const fileInput = qs("#vc-file-input");
  const recordBtn = qs("#vc-record-btn");
  const recordTriggerWrap = qs(".vc-record-trigger-wrap");
  const deviceDropdown = qs("#vc-device-dropdown");

  dropzone.addEventListener("click", (e) => {
    if (recordTriggerWrap.contains(e.target) || deviceDropdown.contains(e.target)) return;
    fileInput.click();
  });
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("vc-drag-over");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("vc-drag-over"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("vc-drag-over");
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file) handleFile(file);
  });

  recordBtn.addEventListener("click", toggleDeviceDropdown);
}

async function toggleDeviceDropdown(e) {
  e.stopPropagation();
  const dropdown = qs("#vc-device-dropdown");
  if (!dropdown) return;
  if (!dropdown.hidden) {
    dropdown.hidden = true;
    return;
  }
  dropdown.hidden = false;
  dropdown.innerHTML = `<div class="vc-device-item" data-device-id="">Default microphone</div>`;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");
    mics.forEach((d, i) => {
      const item = document.createElement("div");
      item.className = "vc-device-item";
      item.dataset.deviceId = d.deviceId;
      item.textContent = d.label || `Microphone ${i + 1}`;
      dropdown.appendChild(item);
    });
  } catch {
    // enumerateDevices unsupported/blocked — the default-mic option above still works.
  }
  if (!qs("#vc-device-dropdown")) return; // Step 1 moved on while this was pending
  dropdown.querySelectorAll(".vc-device-item").forEach((item) => {
    item.addEventListener("click", (ev) => {
      ev.stopPropagation();
      dropdown.hidden = true;
      runMainRecording(item.dataset.deviceId || undefined);
    });
  });
}

function handleFile(file) {
  // The file input's accept="audio/*,video/*" only filters the OS file picker
  // — a drag-and-drop is never filtered by it, so an arbitrary file type can
  // land here and silently fail to play/decode later without this check.
  if (!file.type.startsWith("audio/") && !file.type.startsWith("video/")) {
    state.error = "Please choose an audio or video file.";
    renderStep1();
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    state.error = "That file is larger than 10MB — please choose a smaller file.";
    renderStep1();
    return;
  }
  state.audioBlob = file;
  state.audioUrl = URL.createObjectURL(file);
  state.audioSource = "upload";
  state.fileName = file.name;
  state.error = null;
  renderStep3();
}

// ---------- Step 2: Active recording ----------

// renderShell(3) renders the countdown screen ONCE — calling setStepHtml (and
// so replacing the whole modal body + retriggering its entrance animation) on
// every tick made the entire title+number visibly flicker/flash every second.
// Ticking down just updates the #vc-countdown-number element's text in place.
async function runCountdownInto(renderShell) {
  renderShell(3);
  for (let n = 3; n >= 1; n--) {
    const numberEl = qs("#vc-countdown-number");
    if (numberEl) {
      numberEl.textContent = n;
      // Changing textContent alone doesn't restart a CSS animation already
      // running on the element — force it to replay from the start each tick.
      numberEl.style.animation = "none";
      void numberEl.offsetWidth;
      numberEl.style.animation = "";
    }
    await sleep(1000);
    if (!state.modalOpen) return false;
  }
  return true;
}

async function runMainRecording(deviceId) {
  state.step = 2;
  state.error = null;

  const proceeded = await runCountdownInto((n) => {
    setStepHtml(`
      <p class="vc-countdown-label">Get ready to speak...</p>
      <p class="vc-countdown-number" id="vc-countdown-number">${n}</p>
    `);
  });
  if (!proceeded) return;

  setStepHtml(`
    <canvas id="vc-bars" class="vc-waveform-canvas" width="460" height="90"></canvas>
    <p class="vc-timer" id="vc-timer">00:00 / ${formatTime(STAGE1_MAX_MS)}</p>
    <p class="vc-inline-warning" id="vc-warning"></p>
    <button id="vc-stop-btn" class="vc-stop-btn" type="button" aria-label="Stop recording">&#9632;</button>
  `);
  const timerEl = qs("#vc-timer");
  const warning = createWarningController(qs("#vc-warning"));
  const stopBtn = qs("#vc-stop-btn");

  let resolveBlob;
  const blobPromise = new Promise((resolve) => {
    resolveBlob = resolve;
  });

  try {
    await mainRecorder.start((blob) => resolveBlob(blob), { deviceId });
  } catch (err) {
    state.error = `Couldn't access microphone: ${err.message}`;
    renderStep1();
    return;
  }

  activeWaveformStop = safeStartWaveform(mainRecorder.liveStream, qs("#vc-bars"), warning.onLevel);
  activeIntervalHandle = setInterval(() => {
    if (!qs("#vc-timer")) return;
    updateTimerLabel(timerEl, mainRecorder.elapsedMs, STAGE1_MAX_MS);
  }, 200);

  stopBtn.addEventListener("click", async () => {
    if (!mainRecorder.canStopNow) {
      warning.showOverride("Keep going — we need at least 10 seconds for a good clone.");
      return;
    }
    stopBtn.disabled = true;
    resolveBlob(await mainRecorder.stop());
  });

  const blob = await blobPromise;
  clearInterval(activeIntervalHandle);
  activeIntervalHandle = null;
  if (activeWaveformStop) {
    activeWaveformStop();
    activeWaveformStop = null;
  }
  if (!state.modalOpen) return;

  state.audioBlob = blob;
  state.audioUrl = URL.createObjectURL(blob);
  state.audioSource = "record";
  state.fileName = "Recording 1";
  renderStep3();
}

// ---------- Step 3: Review & Metadata ----------

function renderStep3() {
  state.step = 3;
  setStepHtml(`
    <h2 class="vc-title">Review Your Recording</h2>
    <div class="vc-file-card">
      <div class="vc-file-info">
        <div class="vc-file-name">${escapeHtml(state.fileName || "Recording 1")}</div>
        <canvas id="vc-thumb-waveform" class="vc-thumb-waveform" width="200" height="48"></canvas>
        <div class="vc-file-duration" id="vc-duration">00:00</div>
      </div>
      <div class="vc-play-ring-wrap">
        <svg class="vc-play-ring" viewBox="0 0 56 56">
          <circle class="vc-play-ring-bg" cx="28" cy="28" r="24"></circle>
          <circle class="vc-play-ring-fg" id="vc-ring-fg" cx="28" cy="28" r="24"></circle>
        </svg>
        <button id="vc-play-btn" class="vc-play-btn" type="button" aria-label="Play">&#9654;</button>
      </div>
      <button id="vc-delete-btn" class="vc-delete-btn" type="button" title="Delete and re-record">&#128465;</button>
    </div>

    <label class="vc-checkbox-label">
      <input type="checkbox" id="vc-noise-checkbox" ${state.removeNoise ? "checked" : ""} />
      <span class="vc-checkbox-box"></span>
      Remove background noise from audio recordings
    </label>

    <div class="vc-field-floating">
      <input type="text" id="vc-name-input" placeholder=" " autocomplete="off" />
      <label for="vc-name-input">Name</label>
    </div>

    <div class="vc-field">
      <label for="vc-language-select">Language</label>
      <select id="vc-language-select" class="vc-select">
        ${LANGUAGES.map((l) => `<option value="${l.code}" ${l.code === state.language ? "selected" : ""}>${l.label}</option>`).join("")}
      </select>
    </div>

    <label class="vc-checkbox-label">
      <input type="checkbox" id="vc-legal-checkbox" ${state.legalConfirmed ? "checked" : ""} />
      <span class="vc-checkbox-box"></span>
      I confirm that I have all necessary rights and consents to upload and clone this voice
    </label>

    <p class="status">${state.error ? escapeHtml(state.error) : ""}</p>
    <div class="vc-footer-row">
      <span></span>
      <button id="vc-save-btn" class="btn btn-primary" type="button" ${state.legalConfirmed ? "" : "disabled"}>Save voice</button>
    </div>
  `);

  activeAudioPreviewStop = setupPlayPauseWithRing(state.audioUrl, qs("#vc-play-btn"), qs("#vc-ring-fg"), qs("#vc-duration"));
  drawThumbnailWaveform(state.audioUrl, qs("#vc-thumb-waveform"));

  const goBackOrReRecord = () => {
    if (activeAudioPreviewStop) {
      activeAudioPreviewStop();
      activeAudioPreviewStop = null;
    }
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioBlob = null;
    state.audioUrl = null;
    // An uploaded file can't be "re-recorded" — send that case back to Step 1
    // to choose a method again; a real recording goes straight back into Step 2.
    if (state.audioSource === "upload") renderStep1();
    else runMainRecording();
  };
  qs("#vc-delete-btn").addEventListener("click", goBackOrReRecord);

  qs("#vc-noise-checkbox").addEventListener("change", (e) => {
    state.removeNoise = e.target.checked; // cosmetic only — see runCloning()
  });
  qs("#vc-language-select").addEventListener("change", (e) => {
    state.language = e.target.value;
  });

  const nameInput = qs("#vc-name-input");
  const saveBtn = qs("#vc-save-btn");
  // Set via property, not an interpolated HTML attribute — avoids any escaping
  // edge case. Blank unless the user already typed something this session.
  nameInput.value = state.voiceName === "My Voice" ? "" : state.voiceName;

  qs("#vc-legal-checkbox").addEventListener("change", (e) => {
    state.legalConfirmed = e.target.checked;
    saveBtn.disabled = !state.legalConfirmed;
  });

  saveBtn.addEventListener("click", () => {
    state.voiceName = nameInput.value.trim() || "My Voice";
    runCloning();
  });
}

// ---------- Cloning (loading screen between Step 3 and Step 4) ----------

async function runCloning() {
  // The review-step preview audio has no visible player once we navigate
  // away — if it's still playing, it'd otherwise keep playing audibly in the
  // background with no way to stop it.
  if (activeAudioPreviewStop) {
    activeAudioPreviewStop();
    activeAudioPreviewStop = null;
  }
  setStepHtml(`
    <h2 class="vc-title vc-centered">Creating your voice profile...</h2>
    <div class="vc-indeterminate-track"><div class="vc-indeterminate-bar"></div></div>
    <p class="vc-loading-text">This usually takes just a few seconds.</p>
  `);

  try {
    // Noise gate intentionally NOT applied here: pre-processing the sample
    // before ElevenLabs sees it was degrading clone quality — ElevenLabs does
    // its own internal processing on raw audio. The checkbox above is cosmetic.
    const voiceId = await createVoiceProfile(state.audioBlob, state.voiceName.trim() || "My Voice");
    state.voiceId = voiceId;
    persistVoiceId(voiceId);
    onVoiceReadyCallback(voiceId);
    state.attempt = 0;
    renderVerifyIntro();
  } catch (err) {
    // Friendly message via the same shared mapping generate-errors use; route
    // back to Step 3 so they can retry without re-recording.
    state.error = friendlyErrorMessage(err);
    renderStep3();
  }
}

// ---------- Step 4: Verification ----------

function renderVerifyIntro() {
  state.step = 4;
  setStepHtml(`
    <h2 class="vc-title vc-centered">Voice Verification</h2>
    <p class="vc-subtitle vc-centered">Verified voices may gain access to additional features over time.</p>
    <div class="vc-footer-row">
      <button id="vc-skip-btn" class="btn btn-secondary" type="button">Skip</button>
      <button id="vc-verify-start-btn" class="btn btn-primary" type="button">Start</button>
    </div>
  `);
  qs("#vc-verify-start-btn").addEventListener("click", runVerificationAttempt);
  qs("#vc-skip-btn").addEventListener("click", finishToStep5);
}

async function runVerificationAttempt() {
  state.attempt++;
  state.currentSentence = pickSentence();

  const proceeded = await runCountdownInto((n) => {
    setStepHtml(`
      <div class="vc-sentence-card">${escapeHtml(state.currentSentence)}</div>
      <p class="vc-countdown-label">Get ready to speak...</p>
      <p class="vc-countdown-number" id="vc-countdown-number">${n}</p>
    `);
  });
  if (!proceeded) return;

  setStepHtml(`
    <div class="vc-sentence-card">${escapeHtml(state.currentSentence)}</div>
    <canvas id="vc-bars" class="vc-waveform-canvas" width="460" height="90"></canvas>
    <p class="vc-timer" id="vc-timer">00:00 / ${formatTime(VERIFY_MAX_MS)}</p>
    <p class="vc-inline-warning" id="vc-warning"></p>
    <button id="vc-stop-btn" class="vc-stop-btn" type="button" aria-label="Stop recording">&#9632;</button>
  `);
  const timerEl = qs("#vc-timer");
  const warning = createWarningController(qs("#vc-warning"));
  const stopBtn = qs("#vc-stop-btn");

  let resolveBlob;
  const blobPromise = new Promise((resolve) => {
    resolveBlob = resolve;
  });

  try {
    await verifyRecorder.start((blob) => resolveBlob(blob));
  } catch (err) {
    state.verifyPassed = false;
    state.failureReason = "voice";
    state.exhausted = state.attempt >= MAX_VERIFY_ATTEMPTS;
    renderVerifyResult();
    return;
  }

  activeWaveformStop = safeStartWaveform(verifyRecorder.liveStream, qs("#vc-bars"), warning.onLevel);
  activeIntervalHandle = setInterval(() => {
    if (!qs("#vc-timer")) return;
    updateTimerLabel(timerEl, verifyRecorder.elapsedMs, VERIFY_MAX_MS);
  }, 200);

  const speech = isSpeechRecognitionSupported
    ? transcribeLive(VERIFY_MAX_MS, state.language)
    : { promise: Promise.resolve(null), cancel: () => {}, stop: () => {} };

  // Lets closeModal()/skip mid-recording cancel BOTH together — otherwise
  // SpeechRecognition keeps listening in the background after the UI moves on.
  activeVerifyCancel = () => {
    speech.cancel();
    if (verifyRecorder.isRecording) verifyRecorder.stop().then(resolveBlob);
  };

  stopBtn.addEventListener("click", async () => {
    stopBtn.disabled = true;
    // Without ending speech recognition too, Promise.all below waits for
    // speech.promise's own internal timer (the full VERIFY_MAX_MS) even though
    // the recorder already stopped — the screen would sit frozen on the
    // recording view for up to 15s after a manual stop. stop() (not cancel())
    // ends it gracefully so the transcript recognized so far still counts.
    speech.stop();
    resolveBlob(await verifyRecorder.stop());
  });

  const [blob, transcript] = await Promise.all([blobPromise, speech.promise]);
  activeVerifyCancel = null;
  clearInterval(activeIntervalHandle);
  activeIntervalHandle = null;
  if (activeWaveformStop) {
    activeWaveformStop();
    activeWaveformStop = null;
  }
  if (!state.modalOpen || state.step !== 4) return;

  setStepHtml(`
    <div class="vc-sentence-card">${escapeHtml(state.currentSentence)}</div>
    <p class="vc-footnote vc-centered">Recording captured.</p>
    <div class="vc-footer-row">
      <button id="vc-skip-btn" class="btn btn-secondary" type="button">Skip</button>
      <button id="vc-submit-btn" class="btn btn-primary" type="button">Submit recording</button>
    </div>
  `);
  qs("#vc-skip-btn").addEventListener("click", finishToStep5);
  qs("#vc-submit-btn").addEventListener("click", () => processVerification(blob, transcript));
}

async function processVerification(blob, transcript) {
  setStepHtml(`<div class="vc-spinner"></div>`);

  // transcript === null means SpeechRecognition wasn't supported/available —
  // don't fail the user for a browser limitation; treat text-match as passed.
  const textOk = transcript == null ? true : wordOverlapRatio(transcript, state.currentSentence) >= TEXT_MATCH_THRESHOLD;
  const voiceOk = await checkVoiceSimilarity(state.audioUrl, blob);

  // The checks themselves are near-instant; a truly immediate flip would look
  // skipped/broken rather than like real verification happened.
  await sleep(1000);
  if (!state.modalOpen || state.step !== 4) return;

  state.verifyPassed = textOk && voiceOk;
  state.failureReason = !textOk ? "text" : "voice";
  state.exhausted = !state.verifyPassed && state.attempt >= MAX_VERIFY_ATTEMPTS;
  renderVerifyResult();
}

function renderVerifyResult() {
  if (state.verifyPassed) {
    setStepHtml(`
      <div class="vc-result-icon">
        <svg viewBox="0 0 52 52" class="vc-check-svg">
          <circle class="vc-check-circle" cx="26" cy="26" r="23" fill="none"></circle>
          <path class="vc-check-path" fill="none" d="M15 27 L23 35 L38 18"></path>
        </svg>
      </div>
      <p class="vc-title vc-centered">Voice verified successfully!</p>
    `);
    setTimeout(() => {
      if (state.modalOpen && state.step === 4) finishToStep5();
    }, 1500);
    return;
  }

  const message = FAIL_MESSAGES[state.failureReason];

  if (state.exhausted) {
    setStepHtml(`
      <div class="vc-alert vc-alert-slide">${escapeHtml(message)}</div>
      <p class="hint">Continuing with unverified voice — clone quality may vary.</p>
      <div class="vc-footer-row"><span></span><button id="vc-continue-anyway-btn" class="btn btn-primary" type="button">Continue</button></div>
    `);
    qs("#vc-continue-anyway-btn").addEventListener("click", finishToStep5);
    return;
  }

  setStepHtml(`
    <div class="vc-alert vc-alert-slide">${escapeHtml(message)}</div>
    <p class="hint">Attempt ${state.attempt} of ${MAX_VERIFY_ATTEMPTS}.</p>
    <div class="vc-footer-row">
      <button id="vc-skip-btn" class="btn btn-secondary" type="button">Skip</button>
      <button id="vc-retry-btn" class="btn btn-primary" type="button">Try again</button>
    </div>
  `);
  qs("#vc-retry-btn").addEventListener("click", runVerificationAttempt);
  qs("#vc-skip-btn").addEventListener("click", finishToStep5);
}

// ---------- Step 5: Completion ----------

function finishToStep5() {
  stopAnyActiveCapture();
  state.step = 5;
  setStepHtml(`
    <h2 class="vc-title vc-centered">Try out your new clone</h2>
    <p class="vc-subtitle vc-centered">Your voice is now ready to be used throughout the product.</p>
    <div class="vc-tile-list">
      <button class="vc-tile" id="vc-tile-generate" type="button">
        <span class="vc-tile-icon">🎤</span>
        <span class="vc-tile-text">
          <span class="vc-tile-title">Generate speech</span>
          <span class="vc-tile-desc">Take your new voice for a test drive with Text to Speech</span>
        </span>
      </button>
      <button class="vc-tile" id="vc-tile-practice" type="button">
        <span class="vc-tile-icon">🗣️</span>
        <span class="vc-tile-text">
          <span class="vc-tile-title">Practice delivery</span>
          <span class="vc-tile-desc">Compare your delivery against your cloned voice</span>
        </span>
      </button>
      <button class="vc-tile" id="vc-tile-sample" type="button">
        <span class="vc-tile-icon">📖</span>
        <span class="vc-tile-text">
          <span class="vc-tile-title">Hear a sample</span>
          <span class="vc-tile-desc">Listen to your voice read a sample paragraph</span>
        </span>
      </button>
    </div>
    <div id="vc-sample-player" class="vc-sample-player" hidden></div>
    <div class="vc-footer-row"><span></span><button id="vc-skip-final-btn" class="btn btn-secondary" type="button">Skip</button></div>
  `);

  qs("#vc-tile-generate").addEventListener("click", () => {
    closeModal();
    renderTrigger();
    const scriptInput = document.getElementById("script-input");
    if (scriptInput) scriptInput.focus();
  });

  qs("#vc-tile-practice").addEventListener("click", () => {
    closeModal();
    renderTrigger();
    document.getElementById("comparison-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  qs("#vc-tile-sample").addEventListener("click", playSampleInPlace);

  qs("#vc-skip-final-btn").addEventListener("click", () => {
    closeModal();
    renderTrigger();
  });

  renderTrigger();
}

async function playSampleInPlace() {
  const player = qs("#vc-sample-player");
  if (!player) return;
  player.hidden = false;
  player.innerHTML = "";
  const spinner = document.createElement("div");
  spinner.className = "vc-spinner";
  player.appendChild(spinner);

  try {
    const { url } = await synthesizeSpeech(SAMPLE_PARAGRAPH, null, { fallbackVoiceId: state.voiceId });
    const currentPlayer = qs("#vc-sample-player");
    if (!currentPlayer) return; // modal moved on/closed while generating
    currentPlayer.innerHTML = "";
    const audioEl = document.createElement("audio");
    audioEl.controls = true;
    audioEl.autoplay = true;
    audioEl.src = url;
    currentPlayer.appendChild(audioEl);
  } catch (err) {
    const currentPlayer = qs("#vc-sample-player");
    if (!currentPlayer) return;
    currentPlayer.innerHTML = `<p class="status">${escapeHtml(friendlyErrorMessage(err))}</p>`;
  }
}

// ---------- outer trigger (always visible on the page, outside the modal) ----------

function renderTrigger() {
  if (state.voiceId) {
    triggerContainer.innerHTML = `
      <div class="vc-trigger-ready">
        <span class="status">&check; Voice ready${state.voiceName ? `: ${escapeHtml(state.voiceName)}` : ""}</span>
        <button id="vc-change-btn" class="btn btn-secondary" type="button">Change Voice</button>
      </div>
    `;
    triggerContainer.querySelector("#vc-change-btn").addEventListener("click", () => {
      clearPersistedVoiceId();
      state.voiceId = null;
      renderTrigger();
    });
    return;
  }

  triggerContainer.innerHTML = `
    <button id="vc-open-btn" class="btn btn-primary" type="button">Clone Your Voice</button>
    <details class="vc-trigger-existing">
      <summary>Already have an ElevenLabs voice ID?</summary>
      <div class="field voice-id-field">
        <input type="text" id="vc-existing-id-input" placeholder="e.g. 42xgKaeATtWRPTmYPyGQ" autocomplete="off" spellcheck="false" />
      </div>
    </details>
  `;
  triggerContainer.querySelector("#vc-open-btn").addEventListener("click", openModal);
  triggerContainer.querySelector("#vc-existing-id-input").addEventListener("input", (e) => {
    const value = e.target.value.trim();
    if (value) {
      persistVoiceId(value);
      state.voiceId = value;
      onVoiceReadyCallback(value);
      renderTrigger();
    }
  });
}

// ---------- public API ----------

/**
 * @param {HTMLElement} containerEl - where the compact trigger renders (the modal
 *   itself is appended to document.body separately, once, on init)
 * @param {(voiceId: string) => void} onVoiceReady - called once a usable
 *   voice_id exists (fresh clone, verification pass/skip, or a pasted ID)
 */
export function init(containerEl, onVoiceReady) {
  triggerContainer = containerEl;
  onVoiceReadyCallback = onVoiceReady;
  createModalDom();

  const cached = readPersistedVoiceId();
  if (cached) {
    state.voiceId = cached;
    onVoiceReadyCallback(cached);
  }
  renderTrigger();
}

/** Clears a stale voice_id (e.g. after a "voice_not_found" error) and resets the trigger. */
export function invalidateVoice() {
  clearPersistedVoiceId();
  state.voiceId = null;
  renderTrigger();
}
