// Voice setup: capture a useful reference, check the real signal, then listen.
// Signal checks never claim to verify identity or guarantee a voice match.
import { VoiceRecorder } from "./recorder.js";
import { logAudio } from "./audioLog.js";
import { createVoiceProfile, getCurrentVoiceProfileId, previewVoice } from "./tts.js";
import { friendlyErrorMessage } from "./errorMessages.js";
import { startLiveRibbon, sampleAudioBufferPeaks, drawRibbon } from "./waveformRibbon.js";
import { analyzeAudioBuffer, MIN_SAMPLE_SECONDS, MAX_SAMPLE_SECONDS } from "./audioQuality.js";

const STORAGE_KEY = "echovoice.voiceId";
const NAME_KEY = "echovoice.voiceName";
const PROFILE_KEY = "echovoice.voiceProfileId";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const SAMPLE_TEXT = "Today I am speaking in my everyday voice at a comfortable pace, so EchoVoice can learn how I naturally sound.";
const READING_PROMPT = [
  SAMPLE_TEXT
];
const ICONS = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/></svg>'
};

let triggerContainer;
let onVoiceReadyCallback;
let overlay;
let body;
let previousFocus;
let previousOverflow = "";
let epoch = 0;
let timer;
let waveform;
let finishCapture;
const recorder = new VoiceRecorder({ minDurationMs: MIN_SAMPLE_SECONDS * 1000, maxDurationMs: MAX_SAMPLE_SECONDS * 1000 });
const state = {
  modalOpen: false, step: 1, voiceId: null, voiceProfileId: null, voiceName: "My voice", candidateId: null, candidateProfileId: null,
  sample: null, sampleUrl: null, sampleName: "", quality: null, peaks: [],
  transcript: "", consent: false, busy: false, previewBusy: false, previewUrl: null, previewText: SAMPLE_TEXT, error: ""
};

const qs = (selector) => body?.querySelector(selector);
const html = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const clock = (seconds) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, "0")}`;
function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* Storage is optional. */ } }
function isCurrent(token) { return state.modalOpen && token === epoch; }

function stopPlayback() { body?.querySelectorAll("audio").forEach((audio) => audio.pause()); }
function cleanupCapture() {
  clearInterval(timer);
  timer = null;
  waveform?.stopImmediately();
  waveform = null;
  const finish = finishCapture;
  finishCapture = null;
  recorder.cancel().then((blob) => finish?.(blob)).catch(() => finish?.(null));
}
function discardSample() {
  if (state.sampleUrl) URL.revokeObjectURL(state.sampleUrl);
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  Object.assign(state, { sample: null, sampleUrl: null, sampleName: "", quality: null, peaks: [], transcript: "", previewUrl: null, consent: false, error: "" });
}
function resetCapture() {
  ++epoch;
  cleanupCapture();
  stopPlayback();
  discardSample();
  state.candidateId = null;
  state.candidateProfileId = null;
  state.step = 1;
  renderCapture();
  renderTrigger();
}

function createModal() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "vc-overlay";
  overlay.hidden = true;
  overlay.innerHTML = '<div class="vc-modal" role="dialog" aria-modal="true" aria-labelledby="vc-heading"><button class="vc-close-btn" type="button" aria-label="Close voice setup">&times;</button><div id="vc-modal-body"></div></div>';
  document.body.appendChild(overlay);
  body = overlay.querySelector("#vc-modal-body");
  overlay.querySelector(".vc-close-btn").addEventListener("click", closeModal);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) closeModal(); });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeModal(); }
    if (event.key !== "Tab") return;
    const controls = [...overlay.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), audio[controls], summary, [tabindex="0"]')].filter((el) => !el.hidden && el.getClientRects().length);
    if (!controls.length) return;
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  });
}
function setContent(content) {
  stopPlayback();
  const steps = ["Capture", "Review", "Listen"];
  body.innerHTML = `<div class="vc-progress" aria-hidden="true">${steps.map((_, index) => `<span class="vc-progress-seg ${index + 1 < state.step ? "vc-done" : index + 1 === state.step ? "vc-current" : ""}"></span>`).join("")}</div><p class="vc-progress-label">0${state.step} / 03 &nbsp; ${steps[state.step - 1]}</p><div class="vc-step">${content}</div>`;
  const heading = qs("#vc-heading");
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
}
export function openModal() {
  createModal();
  if (state.modalOpen) return;
  document.dispatchEvent(new Event("voice-capture-opening"));
  ++epoch;
  state.modalOpen = true;
  previousFocus = document.activeElement;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  overlay.hidden = false;
  document.querySelector('main').inert = true;
  document.querySelector('header.navbar').inert = true;
  requestAnimationFrame(() => { if (state.modalOpen) overlay.classList.add("vc-open"); });
  if (state.busy) renderCreating();
  else if (state.candidateId) renderAudition();
  else if (state.sample && state.quality) renderReview();
  else {
    discardSample();
    state.step = 1;
    renderCapture();
  }
}
function closeModal() {
  if (!state.modalOpen) return;
  ++epoch;
  state.modalOpen = false;
  cleanupCapture();
  stopPlayback();
  document.body.style.overflow = previousOverflow;
  overlay.classList.remove("vc-open");
  overlay.hidden = true;
  document.querySelector('main').inert = false;
  document.querySelector('header.navbar').inert = false;
  previousFocus?.focus?.();
  renderTrigger();
}

function renderCapture() {
  state.step = 1;
  setContent(`
    <p class="vc-modal-kicker">A voice that feels familiar</p>
    <h2 class="vc-title" id="vc-heading">Start with your real voice.</h2>
    <p class="vc-subtitle">A short, exact recording gives the voice model a clearer reference.</p>
    <div class="vc-tip-cards">
      <div class="vc-tip-card"><span class="vc-tip-icon">01</span><div><div class="vc-tip-title">Find a quiet space</div><div class="vc-tip-desc">One speaker. No music, echo, or other voices.</div></div></div>
      <div class="vc-tip-card"><span class="vc-tip-icon">02</span><div><div class="vc-tip-title">Sound like yourself</div><div class="vc-tip-desc">Your usual accent and speaking voice. No performance needed.</div></div></div>
      <div class="vc-tip-card"><span class="vc-tip-icon">03</span><div><div class="vc-tip-title">Keep your distance steady</div><div class="vc-tip-desc">About a handspan from your microphone. Speak comfortably.</div></div></div>
    </div>
    <div class="vc-field"><label for="vc-device-select">Microphone</label><select class="vc-select" id="vc-device-select"><option value="">Default microphone</option></select></div>
    <div class="vc-capture-actions"><button class="btn btn-primary" id="vc-record-btn" type="button">${ICONS.mic} Record my voice</button><button class="btn btn-secondary" id="vc-upload-btn" type="button">${ICONS.upload} Upload audio</button></div>
    <div class="vc-dropzone" id="vc-dropzone" tabindex="0" role="button" aria-label="Choose an audio file"><p class="vc-dropzone-text">Or drop an audio file here</p><p class="vc-footnote">7–10 seconds · MP3, WAV, M4A, WebM, Ogg or FLAC · up to 10 MB</p></div>
    <input type="file" id="vc-file-input" accept="audio/*,.mp3,.wav,.m4a,.mp4,.webm,.ogg,.flac" hidden />
    <p class="vc-inline-warning" role="status">${html(state.error)}</p>
    <p class="vc-footnote">We check duration and recording levels here. You will listen to the clone before choosing it.</p>
  `);
  const token = epoch;
  const select = qs("#vc-device-select");
  navigator.mediaDevices?.enumerateDevices?.().then((devices) => {
    if (!isCurrent(token) || !select.isConnected) return;
    for (const [index, device] of devices.filter((item) => item.kind === "audioinput" && item.deviceId && item.deviceId !== "default").entries()) {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone ${index + 1}`;
      select.appendChild(option);
    }
  }).catch(() => {});
  qs("#vc-record-btn").addEventListener("click", () => runRecording(select.value || undefined));
  const fileInput = qs("#vc-file-input");
  const dropzone = qs("#vc-dropzone");
  const choose = () => fileInput.click();
  qs("#vc-upload-btn").addEventListener("click", choose);
  dropzone.addEventListener("click", choose);
  dropzone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); } });
  dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("vc-drag-over"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("vc-drag-over"));
  dropzone.addEventListener("drop", (event) => { event.preventDefault(); dropzone.classList.remove("vc-drag-over"); if (event.dataTransfer.files[0]) handleFile(event.dataTransfer.files[0]); });
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });
}
function handleFile(file) {
  if (!file.type.startsWith("audio/") && !/\.(mp3|wav|m4a|mp4|webm|ogg|flac)$/i.test(file.name)) {
    state.error = "Choose a supported audio file, such as MP3, WAV, or M4A.";
    renderCapture();
    return;
  }
  if (!file.size || file.size > MAX_UPLOAD_BYTES) {
    state.error = file.size ? "This file is over 10 MB. Choose a smaller audio file." : "This file is empty. Choose another recording.";
    renderCapture();
    return;
  }
  checkSample(file, file.name, "");
}
async function runRecording(deviceId) {
  const token = ++epoch;
  state.error = "";
  setContent('<h2 class="vc-title" id="vc-heading">Connect your microphone.</h2><p class="vc-subtitle">Allow microphone access in your browser to start recording.</p><div class="vc-spinner" role="status" aria-label="Waiting for microphone"></div>');
  let resolveCapture;
  const captured = new Promise((resolve) => { resolveCapture = resolve; });
  finishCapture = resolveCapture;
  try {
    const started = await recorder.start(resolveCapture, { deviceId });
    if (!started || !isCurrent(token)) return;
  } catch (error) {
    if (!isCurrent(token)) return;
    state.error = error.name === "NotAllowedError" ? "Microphone access was denied. Allow it in your browser, or upload a recording." : error.name === "NotFoundError" ? "No microphone was found. Connect one or upload a recording." : "We could not start your microphone. Check that it is connected and not in use, or upload audio.";
    renderCapture();
    return;
  }
  setContent(`
    <p class="vc-modal-kicker">Recording your reference</p>
    <h2 class="vc-title" id="vc-heading">Just speak like you.</h2>
    <p class="vc-subtitle">Read this sentence exactly as written in your natural voice.</p>
    <div class="vc-reading-prompt" tabindex="0" aria-label="Optional reading prompt">${READING_PROMPT.map((paragraph) => `<p>${paragraph}</p>`).join("")}</div>
    <canvas id="vc-bars" class="vc-waveform-canvas vc-waveform-visible" width="460" height="70" aria-hidden="true"></canvas>
    <div class="vc-recording-progress" role="progressbar" aria-label="Recording duration" aria-valuemin="0" aria-valuemax="10" aria-valuenow="0"><div class="vc-progress-fill" id="vc-capture-fill"></div></div>
    <p class="vc-timer" id="vc-timer">0:00 / 0:10</p>
    <p class="vc-inline-warning" id="vc-warning" role="status">Keep speaking naturally. Your recording stays unprocessed.</p>
    <div class="vc-footer-row"><button id="vc-cancel-recording" class="btn btn-secondary" type="button">Start over</button><button id="vc-stop-btn" class="btn btn-primary" type="button" disabled>Keep going · 7s left</button></div>
  `);
  const stopButton = qs("#vc-stop-btn");
  const timerLabel = qs("#vc-timer");
  const progress = qs(".vc-recording-progress");
  const fill = qs("#vc-capture-fill");
  const warning = qs("#vc-warning");
  let quietSince = null;
  try {
    waveform = startLiveRibbon(recorder.liveStream, qs("#vc-bars"), { color: "#c7f86d", onLevel(level) {
      if (level < 0.012) {
        quietSince ??= performance.now();
        if (performance.now() - quietSince > 3500) warning.textContent = "Very little sound is reaching your microphone. Check mute or move a little closer.";
      } else {
        quietSince = null;
        warning.textContent = "Keep speaking naturally. Your recording stays unprocessed.";
      }
    } });
  } catch { /* The recorder still works without the optional visualizer. */ }
  timer = setInterval(() => {
    const seconds = Math.min(MAX_SAMPLE_SECONDS, recorder.elapsedMs / 1000);
    timerLabel.textContent = `${clock(seconds)} / 0:10`;
    fill.style.transform = `scaleX(${seconds / MAX_SAMPLE_SECONDS})`;
    progress.setAttribute("aria-valuenow", String(Math.floor(seconds)));
    stopButton.disabled = !recorder.canStopNow;
    stopButton.textContent = recorder.canStopNow ? "Finish recording" : `Keep going · ${Math.ceil(MIN_SAMPLE_SECONDS - seconds)}s left`;
  }, 200);
  qs("#vc-cancel-recording").addEventListener("click", resetCapture);
  stopButton.addEventListener("click", async () => {
    if (!recorder.canStopNow) return;
    stopButton.disabled = true;
    resolveCapture(await recorder.stop());
  });
  const blob = await captured;
  if (!isCurrent(token)) return;
  clearInterval(timer);
  timer = null;
  waveform?.stopImmediately();
  waveform = null;
  finishCapture = null;
  await checkSample(blob, "Your voice recording", READING_PROMPT.join(" "));
}

async function checkSample(blob, name, transcript) {
  const token = ++epoch;
  state.step = 2;
  setContent('<h2 class="vc-title" id="vc-heading">Checking your recording.</h2><p class="vc-subtitle">Reading the actual duration and looking for silence or distortion.</p><div class="vc-spinner" role="status" aria-label="Checking recording"></div>');
  let context;
  try {
    if (!blob?.size) throw new Error("empty");
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    context = new AudioContextClass();
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    if (!isCurrent(token)) return;
    const quality = analyzeAudioBuffer(buffer);
    discardSample();
    state.sample = blob;
    state.sampleUrl = URL.createObjectURL(blob);
    state.sampleName = name;
    state.transcript = transcript;
    state.quality = quality;
    state.peaks = sampleAudioBufferPeaks(buffer, 100);
    renderReview();
  } catch {
    if (!isCurrent(token)) return;
    state.error = "We could not read this audio. Try an MP3 or WAV file, or record with your microphone.";
    renderCapture();
  } finally { context?.close().catch(() => {}); }
}
function renderReview() {
  state.step = 2;
  const quality = state.quality;
  const level = quality.rmsDb < -36 ? "Quiet" : "Usable level";
  const peakLabel = quality.clippingRatio >= 0.001 ? "Check peaks" : "No overload found";
  setContent(`
    <p class="vc-modal-kicker">The details make the difference</p>
    <h2 class="vc-title" id="vc-heading">Give it a quick listen.</h2>
    <p class="vc-subtitle">You should hear one clear, natural voice throughout. Background music, echo, and other speakers can change the clone.</p>
    <div class="vc-file-card"><div class="vc-file-info"><div class="vc-file-name">${html(state.sampleName)}</div><canvas id="vc-thumb-waveform" class="vc-thumb-waveform" width="420" height="48" aria-hidden="true"></canvas></div><span class="vc-file-duration">${clock(quality.durationSeconds)}</span></div>
    <audio class="vc-source-audio" id="vc-source-audio" controls preload="metadata" aria-label="Listen to original recording"></audio>
    <div class="vc-quality-grid"><div class="vc-quality-stat"><span>Duration</span><strong>${clock(quality.durationSeconds)}</strong></div><div class="vc-quality-stat"><span>Recording level</span><strong>${level}</strong></div><div class="vc-quality-stat"><span>Signal peaks</span><strong>${peakLabel}</strong></div></div>
    ${quality.issues.length ? `<ul class="vc-quality-list">${quality.issues.map((issue) => `<li data-severity="${issue.severity}">${html(issue.message)}</li>`).join("")}</ul>` : '<p class="vc-footnote">Basic recording checks passed. These checks cannot judge background noise or how closely the clone will sound like you.</p>'}
    <div class="vc-field"><label for="vc-transcript-input">What you said in this recording</label><textarea class="vc-preview-text" id="vc-transcript-input" rows="5" maxlength="5000" placeholder="Paste the exact words spoken in the recording."></textarea><p class="vc-footnote">Review this carefully. EchoVoice uses it with your original recording to generate the ideal track.</p></div>
    <div class="vc-field-floating"><input id="vc-name-input" type="text" placeholder=" " maxlength="80" autocomplete="off" /><label for="vc-name-input">Name your voice</label></div>
    <label class="vc-checkbox-label"><input id="vc-legal-checkbox" type="checkbox" ${state.consent ? "checked" : ""} /><span class="vc-checkbox-box"></span><span>I have permission to clone this voice and consent to sending this recording to the voice services used by EchoVoice. Recordings and generated clips may also be saved for app testing.</span></label>
    <p class="vc-inline-warning" role="status">${html(state.error)}</p>
    <div class="vc-footer-row"><button id="vc-redo-btn" class="btn btn-secondary" type="button">Choose another take</button><button id="vc-save-btn" class="btn btn-primary" type="button" ${state.consent && quality.canCreate && state.transcript.trim() ? "" : "disabled"}>Create my voice</button></div>
  `);
  qs("#vc-source-audio").src = state.sampleUrl;
  qs("#vc-source-audio").load();
  try { drawRibbon(qs("#vc-thumb-waveform"), state.peaks, { color: "#c7f86d" }); } catch { /* Visual only. */ }
  const nameInput = qs("#vc-name-input");
  const transcriptInput = qs("#vc-transcript-input");
  transcriptInput.value = state.transcript;
  const updateSaveState = () => { qs("#vc-save-btn").disabled = !state.consent || !quality.canCreate || !state.transcript.trim(); };
  transcriptInput.addEventListener("input", () => { state.transcript = transcriptInput.value; updateSaveState(); });
  nameInput.value = state.voiceName;
  nameInput.addEventListener("input", () => { state.voiceName = nameInput.value.trim() || "My voice"; });
  qs("#vc-legal-checkbox").addEventListener("change", (event) => {
    state.consent = event.target.checked;
    updateSaveState();
  });
  qs("#vc-redo-btn").addEventListener("click", resetCapture);
  qs("#vc-save-btn").addEventListener("click", runCloning);
}
function renderCreating() {
  state.step = 2;
  setContent('<h2 class="vc-title" id="vc-heading">Finding your familiar sound.</h2><p class="vc-subtitle">Creating your voice from the original recording. You can listen and compare next.</p><div class="vc-indeterminate-track" role="status" aria-label="Creating voice"><div class="vc-indeterminate-bar"></div></div><p class="vc-loading-text">This can take a little while. You can close this window and return.</p>');
}
async function runCloning() {
  if (state.busy || !state.consent || !state.quality?.canCreate || !state.transcript.trim()) return;
  state.busy = true;
  state.error = "";
  renderCreating();
  renderTrigger();
  try {
    logAudio(state.sample, 'recording');
    state.candidateId = await createVoiceProfile(state.sample, state.voiceName, state.transcript.trim());
    state.candidateProfileId = getCurrentVoiceProfileId();
    state.step = 3;
    if (state.modalOpen) renderAudition();
  } catch (error) {
    state.error = friendlyErrorMessage(error);
    if (state.modalOpen) renderReview();
  } finally {
    state.busy = false;
    renderTrigger();
  }
}
function renderAudition() {
  state.step = 3;
  setContent(`
    <p class="vc-modal-kicker">The most useful check is listening</p>
    <h2 class="vc-title" id="vc-heading">Does it sound like you?</h2>
    <p class="vc-subtitle">Compare your recording with a calm preview. Listen for your accent, tone, and the way you shape words.</p>
    <p class="vc-preview-label">01 &nbsp; Your original recording</p><audio class="vc-source-audio" id="vc-source-audio" controls preload="metadata" aria-label="Original voice recording"></audio>
    <div class="vc-field"><label for="vc-preview-text">Words to try in your own language</label><textarea class="vc-preview-text" id="vc-preview-text" rows="3" maxlength="500"></textarea><p class="vc-footnote">Use the same language as your recording to judge the accent fairly.</p></div>
    <p class="vc-preview-label">02 &nbsp; Your cloned voice</p><div id="vc-sample-player" class="vc-sample-player"></div>
    <button id="vc-preview-btn" type="button" class="btn btn-secondary" ${state.previewBusy ? "disabled" : ""}>${state.previewUrl ? "Generate another preview" : state.previewBusy ? "Creating preview…" : "Hear my cloned voice"}</button>
    <p class="vc-footnote">Listen for a natural voice and accurate words. You can use this recording or try another take.</p>
    <p class="vc-inline-warning" id="vc-preview-error" role="status"></p>
    <div class="vc-footer-row"><button id="vc-retry-capture" class="btn btn-secondary" type="button">Improve my recording</button><button id="vc-use-voice" class="btn btn-primary" type="button">Use this voice</button></div>
    <p class="vc-footnote">You can try your own words in the studio and replace this voice anytime.</p>
  `);
  qs("#vc-source-audio").src = state.sampleUrl;
  qs("#vc-source-audio").load();
  qs("#vc-preview-text").value = state.previewText;
  qs("#vc-preview-text").addEventListener("input", (event) => { state.previewText = event.target.value; });
  qs("#vc-source-audio").addEventListener("play", () => qs("#vc-preview-audio")?.pause());
  showPreviewPlayer();
  qs("#vc-preview-btn").addEventListener("click", generatePreview);
  qs("#vc-retry-capture").addEventListener("click", resetCapture);
  qs("#vc-use-voice").addEventListener("click", () => {
    if (!state.candidateId) return;
    state.voiceId = state.candidateId;
    state.voiceProfileId = state.candidateProfileId;
    state.candidateId = null;
    state.candidateProfileId = null;
    storageSet(STORAGE_KEY, state.voiceId);
    storageSet(NAME_KEY, state.voiceName);
    storageSet(PROFILE_KEY, state.voiceProfileId);
    onVoiceReadyCallback?.(state.voiceId, state.voiceProfileId);
    closeModal();
    discardSample();
    document.getElementById("script-input")?.focus();
  });
}
function showPreviewPlayer() {
  const player = qs("#vc-sample-player");
  if (!player || !state.previewUrl) return;
  const audio = document.createElement("audio");
  audio.id = "vc-preview-audio";
  audio.controls = true;
  audio.preload = "metadata";
  audio.src = state.previewUrl;
  audio.setAttribute("aria-label", "Cloned voice preview");
  audio.addEventListener("play", () => qs("#vc-source-audio")?.pause());
  player.replaceChildren(audio);
  audio.load();
}
async function generatePreview() {
  if (state.previewBusy || !state.candidateId) return;
  if (!state.previewText.trim()) {
    qs("#vc-preview-error").textContent = "Add a short sentence for your voice to say.";
    return;
  }
  const candidateId = state.candidateId;
  state.previewBusy = true;
  const button = qs("#vc-preview-btn");
  button.disabled = true;
  button.textContent = "Creating preview…";
  qs("#vc-preview-error").textContent = "";
  try {
    const { url } = await previewVoice(state.previewText.trim(), { voiceId: candidateId, voiceProfileId: state.candidateProfileId });
    if (state.candidateId !== candidateId) { URL.revokeObjectURL(url); return; }
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = url;
    if (state.modalOpen && state.step === 3) showPreviewPlayer();
  } catch (error) {
    if (state.candidateId === candidateId && state.modalOpen && state.step === 3) qs("#vc-preview-error").textContent = friendlyErrorMessage(error);
  } finally {
    state.previewBusy = false;
    if (state.modalOpen && state.step === 3) {
      const currentButton = qs("#vc-preview-btn");
      if (currentButton) { currentButton.disabled = false; currentButton.textContent = state.previewUrl ? "Generate another preview" : "Hear my cloned voice"; }
    }
  }
}

function renderTrigger() {
  if (!triggerContainer) return;
  if (state.busy || state.candidateId) {
    triggerContainer.innerHTML = `<div class="vc-trigger-ready"><span class="status">${state.busy ? "Creating your voice…" : "Your new voice is ready to audition"}</span><button id="vc-resume-btn" class="btn btn-primary" type="button">${state.busy ? "View progress" : "Listen & choose"}</button></div>`;
    triggerContainer.querySelector("#vc-resume-btn").addEventListener("click", openModal);
    return;
  }
  if (state.voiceId) {
    triggerContainer.innerHTML = `<div class="vc-trigger-ready"><div class="vc-trigger-copy"><span class="vc-trigger-title">${html(storageGet(NAME_KEY) || state.voiceName)}</span><span class="vc-trigger-subtitle">Voice selected · ready for the studio</span></div><button id="vc-change-btn" class="btn btn-secondary" type="button">Change voice</button></div>`;
    triggerContainer.querySelector("#vc-change-btn").addEventListener("click", openModal);
    return;
  }
  triggerContainer.innerHTML = `<button id="vc-open-btn" class="btn btn-primary" type="button">${ICONS.mic} Set up my voice</button><details class="vc-trigger-existing"><summary>Use an existing voice ID</summary><div class="field voice-id-field"><label for="vc-existing-id-input">Your ElevenLabs voice ID</label><input type="text" id="vc-existing-id-input" placeholder="Paste your voice ID" autocomplete="off" spellcheck="false" maxlength="64" /></div><button id="vc-existing-use" class="btn btn-secondary" type="button">Use voice ID</button><p id="vc-existing-error" class="vc-footnote" role="status"></p></details>`;
  triggerContainer.querySelector("#vc-open-btn").addEventListener("click", openModal);
  const useExisting = () => {
    const value = triggerContainer.querySelector("#vc-existing-id-input").value.trim();
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(value)) {
      triggerContainer.querySelector("#vc-existing-error").textContent = "Paste a complete voice ID from your ElevenLabs library.";
      return;
    }
    state.voiceId = value;
    state.voiceProfileId = null;
    state.voiceName = "My saved voice";
    storageSet(STORAGE_KEY, value);
    storageSet(NAME_KEY, state.voiceName);
    storageSet(PROFILE_KEY, null);
    onVoiceReadyCallback?.(value, null);
    renderTrigger();
  };
  triggerContainer.querySelector("#vc-existing-use").addEventListener("click", useExisting);
  triggerContainer.querySelector("#vc-existing-id-input").addEventListener("keydown", (event) => { if (event.key === "Enter") useExisting(); });
}
export function init(containerEl, onVoiceReady) {
  triggerContainer = containerEl;
  onVoiceReadyCallback = onVoiceReady;
  createModal();
  state.voiceId = storageGet(STORAGE_KEY);
  state.voiceProfileId = storageGet(PROFILE_KEY);
  state.voiceName = storageGet(NAME_KEY) || "My voice";
  if (state.voiceId) onVoiceReadyCallback?.(state.voiceId, state.voiceProfileId);
  renderTrigger();
}
export function invalidateVoice() {
  storageSet(STORAGE_KEY, null);
  storageSet(NAME_KEY, null);
  storageSet(PROFILE_KEY, null);
  state.voiceId = null;
  state.voiceProfileId = null;
  onVoiceReadyCallback?.(null, null);
  renderTrigger();
}
