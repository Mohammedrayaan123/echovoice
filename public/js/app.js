// app.js — wires up the UI. No TTS or recording logic lives here directly;
// it calls into recorder.js/voiceCapture.js and tts.js so those can be swapped
// independently.

import { synthesizeSpeech, getLastAlignment } from "./tts.js";
import { init as initPitchViz, render as renderPitchViz } from "./pitchViz.js";
import {
  init as initComparisonViz,
  compare as compareDeliveries,
  setPlayhead as setComparisonPlayhead,
  reset as resetComparisonViz,
} from "./comparisonViz.js";
import { init as initVoiceCapture, invalidateVoice, openModal as openVoiceCloneModal } from "./voiceCapture.js";
import { VoiceRecorder } from "./recorder.js";
import { friendlyErrorMessage } from "./errorMessages.js";
import { showToast } from "./toast.js";
import {
  drawRibbon,
  sampleAudioBufferPeaks,
  decodeAudioBufferFromUrl,
  startBreathingLoader,
  observeCanvasResize,
} from "./waveformRibbon.js";

// Loading overlay: shown by default in the HTML (no JS needed — see
// index.html), covering the render-blocking wait during a Render cold start.
// Hidden for real at the bottom of this file once the app is functional. The
// 5s safety-net timeout below is only for the case where init throws before
// reaching that point — by the time THIS script is even executing, the real
// cold-start network wait is already over (the browser couldn't have fetched
// and started running it otherwise), so 5s is plenty of slack for the
// synchronous DOM setup below without ever cutting off a legitimate slow
// cold start.
function hideLoadingOverlay() {
  const overlay = document.getElementById("loading-overlay");
  if (!overlay || overlay.style.display === "none") return;
  overlay.style.opacity = "0";
  setTimeout(() => {
    overlay.style.display = "none";
  }, 300);
}
setTimeout(hideLoadingOverlay, 5000);

const scriptInput = document.getElementById("script-input");
const scriptCharCount = document.getElementById("script-char-count");
const languageSelect = document.getElementById("language-select");
const modelSelect = document.getElementById("model-select");

const stabilityInput = document.getElementById("stability-input");
const stabilityValue = document.getElementById("stability-value");
const similarityInput = document.getElementById("similarity-input");
const similarityValue = document.getElementById("similarity-value");
const styleInput = document.getElementById("style-input");
const styleValue = document.getElementById("style-value");

const generateBtn = document.getElementById("generate-btn");
const generateLoading = document.getElementById("generate-loading");
const generateLoadingCanvas = document.getElementById("generate-loading-canvas");
const resultPlayback = document.getElementById("result-playback");
const errorRecovery = document.getElementById("error-recovery");
const errorRecoveryMessage = document.getElementById("error-recovery-message");
const errorRecoveryBtn = document.getElementById("error-recovery-btn");
const errorRecoveryDismiss = document.getElementById("error-recovery-dismiss");

const playbackCard = document.getElementById("playback-card");
const playbackWaveform = document.getElementById("playback-waveform");
const playbackPlayBtn = document.getElementById("playback-play-btn");
const playbackProgressFill = document.getElementById("playback-progress-fill");
const playbackTime = document.getElementById("playback-time");

const backupBtn = document.getElementById("backup-btn");

function showErrorRecovery(message) {
  errorRecoveryMessage.textContent = message;
  errorRecovery.hidden = false;
}

function hideErrorRecovery() {
  errorRecovery.hidden = true;
}

errorRecoveryBtn.addEventListener("click", () => {
  hideErrorRecovery();
  openVoiceCloneModal();
});

errorRecoveryDismiss.addEventListener("click", hideErrorRecovery);

const comparisonSection = document.getElementById("comparison-section");
const comparisonScriptText = document.getElementById("comparison-script-text");
const comparisonRecordBtn = document.getElementById("comparison-record-btn");
const comparisonStatus = document.getElementById("comparison-status");
const comparisonPlayback = document.getElementById("comparison-playback");
const comparisonCompareBtn = document.getElementById("comparison-compare-btn");
const comparisonResults = document.getElementById("comparison-results");
const comparisonPanels = document.getElementById("comparison-panels");
const comparisonMessage = document.getElementById("comparison-message");
const comparisonControls = document.getElementById("comparison-controls");
const scoreRingEl = document.getElementById("score-circle-ring");
const scoreNumberEl = document.getElementById("score-circle-number");
const scoreTierLabelEl = document.getElementById("score-tier-label");
const feedbackCardsEl = document.getElementById("feedback-cards");
const scriptHighlightCardEl = document.getElementById("script-highlight-card");
const scriptHighlightWordsEl = document.getElementById("script-highlight-words");
const detailToggleBtn = document.getElementById("detail-toggle-btn");
const detailCollapseEl = document.getElementById("detail-collapse");
const idealCanvas = document.getElementById("comparison-canvas-ideal");
const attemptCanvas = document.getElementById("comparison-canvas-attempt");
const playIdealBtn = document.getElementById("play-ideal-btn");
const playYoursBtn = document.getElementById("play-yours-btn");
const playBothBtn = document.getElementById("play-both-btn");
const skipBackBtn = document.getElementById("skip-back-btn");
const playPauseBtn = document.getElementById("play-pause-btn");
const skipFwdBtn = document.getElementById("skip-fwd-btn");
const speedBtns = Array.from(document.querySelectorAll(".speed-btn"));
const tryAgainBtn = document.getElementById("try-again-btn");

// A dedicated recorder for the "Now you try" comparison attempt — a one-off
// recording to compare against the AI clip, never used for cloning. 90s cap
// (vs. the 10s default) since a full script read-back can run much longer
// than a cloning sample.
const comparisonRecorder = new VoiceRecorder({ logType: "user-attempt", maxDurationMs: 90_000 });

// Backup clips for demo day — see backup-audio/README.md for how to (re)generate these.
const BACKUP_CLIPS = [
  "backup-audio/clip1.mp3",
  "backup-audio/clip2.mp3",
  "backup-audio/clip3.mp3",
];
let backupIndex = 0;

initPitchViz(document.getElementById("pitch-viz"));
initComparisonViz({
  idealCanvas,
  attemptCanvas,
  messageEl: comparisonMessage,
  panelsEl: comparisonPanels,
  resultsEl: comparisonResults,
  scoreRingEl,
  scoreNumberEl,
  scoreTierLabelEl,
  feedbackCardsEl,
  scriptHighlightCardEl,
  scriptHighlightWordsEl,
  detailToggleBtn,
  detailCollapseEl,
});

// Detailed-graphs collapse: starts closed (comparisonViz.js resets it to this
// state on every fresh compare()/reset()); this click handler just flips it.
detailToggleBtn.addEventListener("click", () => {
  const expanded = detailCollapseEl.classList.toggle("detail-collapse-expanded");
  detailToggleBtn.textContent = expanded ? "Hide detailed pitch analysis ▲" : "Show detailed pitch analysis ▼";
  detailToggleBtn.setAttribute("aria-expanded", String(expanded));
});

// Which audio element(s) "Play/Pause" and skip ±5s act on — set by whichever
// of Play Ideal / Play Yours / Play Both was clicked last. Independent of the
// sync playhead below, which follows whatever's actually playing regardless
// of how it was started (these buttons, or the native <audio controls>).
let transportMode = null; // "ideal" | "attempt" | "both" | null

function activeTransportAudios() {
  if (transportMode === "ideal") return [resultPlayback];
  if (transportMode === "attempt") return [comparisonPlayback];
  if (transportMode === "both") return [resultPlayback, comparisonPlayback];
  return [resultPlayback];
}

function isPlaying(el) {
  return el && !el.paused && !el.ended;
}

// Sync playhead: whichever of the two clips is actually playing drives the
// vertical line on both comparison panels, via rAF against its currentTime.
let playheadRaf = null;

function tickPlayhead() {
  if (isPlaying(resultPlayback)) {
    setComparisonPlayhead(resultPlayback.currentTime);
  } else if (isPlaying(comparisonPlayback)) {
    setComparisonPlayhead(comparisonPlayback.currentTime);
  } else {
    setComparisonPlayhead(null);
    playPauseBtn.textContent = "▶"; // ▶
    return;
  }
  playheadRaf = requestAnimationFrame(tickPlayhead);
}

function startPlayheadSync() {
  if (comparisonControls.hidden) return; // no comparison drawn yet (e.g. AI or attempt playback before Compare) — nothing to sync
  cancelAnimationFrame(playheadRaf);
  playPauseBtn.textContent = "⏸"; // ⏸
  tickPlayhead();
}

for (const el of [resultPlayback, comparisonPlayback]) {
  el.addEventListener("play", startPlayheadSync);
  el.addEventListener("pause", () => {
    if (!isPlaying(resultPlayback) && !isPlaying(comparisonPlayback)) {
      cancelAnimationFrame(playheadRaf);
      setComparisonPlayhead(null);
      playPauseBtn.textContent = "▶";
    }
  });
  el.addEventListener("ended", () => {
    if (!isPlaying(resultPlayback) && !isPlaying(comparisonPlayback)) {
      cancelAnimationFrame(playheadRaf);
      setComparisonPlayhead(null);
      playPauseBtn.textContent = "▶";
    }
  });
}

playIdealBtn.addEventListener("click", () => {
  comparisonPlayback.pause();
  transportMode = "ideal";
  resultPlayback.volume = 1;
  resultPlayback.currentTime = 0;
  resultPlayback.play();
});

playYoursBtn.addEventListener("click", () => {
  resultPlayback.pause();
  transportMode = "attempt";
  comparisonPlayback.volume = 1;
  comparisonPlayback.currentTime = 0;
  comparisonPlayback.play();
});

playBothBtn.addEventListener("click", () => {
  transportMode = "both";
  resultPlayback.volume = 1;
  comparisonPlayback.volume = 0.7; // slight difference so both stay distinguishable while overlapping
  resultPlayback.currentTime = 0;
  comparisonPlayback.currentTime = 0;
  resultPlayback.play();
  comparisonPlayback.play();
});

playPauseBtn.addEventListener("click", () => {
  const targets = activeTransportAudios();
  if (targets.some(isPlaying)) {
    targets.forEach((a) => a.pause());
  } else {
    targets.forEach((a) => a.play());
  }
});

skipBackBtn.addEventListener("click", () => {
  activeTransportAudios().forEach((a) => {
    a.currentTime = Math.max(0, a.currentTime - 5);
  });
});

skipFwdBtn.addEventListener("click", () => {
  activeTransportAudios().forEach((a) => {
    a.currentTime = a.currentTime + 5; // browsers clamp assignment to [0, duration] on their own
  });
});

for (const btn of speedBtns) {
  btn.addEventListener("click", () => {
    const rate = parseFloat(btn.dataset.speed);
    resultPlayback.playbackRate = rate;
    comparisonPlayback.playbackRate = rate;
    speedBtns.forEach((b) => b.classList.toggle("active", b === btn));
  });
}

// --- AI playback card: a frozen "voice ribbon" of the generated clip plus a
// custom play/pause + progress transport. resultPlayback itself stays hidden
// throughout — it's just the audio engine behind this card (and the thing
// the comparison section's "Play Ideal" already drives directly).
let lastPlaybackPeaks = null;

function formatClockTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function redrawPlaybackWaveform() {
  if (lastPlaybackPeaks) drawRibbon(playbackWaveform, lastPlaybackPeaks, { color: "#e4f222" });
}

observeCanvasResize(playbackWaveform, redrawPlaybackWaveform);

async function setupPlaybackCard(url) {
  playbackCard.hidden = false;
  playbackPlayBtn.textContent = "▶";
  playbackProgressFill.style.width = "0%";
  playbackTime.textContent = "00:00 / 00:00";
  lastPlaybackPeaks = null;

  try {
    const buffer = await decodeAudioBufferFromUrl(url);
    lastPlaybackPeaks = sampleAudioBufferPeaks(buffer, 200);
    redrawPlaybackWaveform();
  } catch {
    // Waveform is cosmetic — playback below still works without it.
  }
}

playbackPlayBtn.addEventListener("click", () => {
  if (resultPlayback.paused) {
    resultPlayback.play();
  } else {
    resultPlayback.pause();
  }
});

resultPlayback.addEventListener("play", () => {
  playbackPlayBtn.textContent = "⏸";
});
resultPlayback.addEventListener("pause", () => {
  playbackPlayBtn.textContent = "▶";
});
resultPlayback.addEventListener("timeupdate", () => {
  if (!Number.isFinite(resultPlayback.duration) || resultPlayback.duration === 0) return;
  playbackProgressFill.style.width = `${(resultPlayback.currentTime / resultPlayback.duration) * 100}%`;
  playbackTime.textContent = `${formatClockTime(resultPlayback.currentTime)} / ${formatClockTime(resultPlayback.duration)}`;
});
resultPlayback.addEventListener("ended", () => {
  playbackPlayBtn.textContent = "▶";
});

// currentVoiceId is whatever voiceCapture.js most recently handed us — via a
// fresh clone, a verification pass/skip, or a pasted existing voice_id. It's
// the ONLY thing generate needs; voiceCapture.js owns all the capture/verify
// state and its own persistence.
let currentVoiceId = null;

initVoiceCapture(document.getElementById("capture-container"), (voiceId) => {
  currentVoiceId = voiceId;
  updateGenerateAvailability();
});

// --- Persisted voice_settings (survive a page reload; local to this browser,
// nothing sensitive, just convenience) ---
// Bumped to v2 (was "echovoice.voiceSettings") when the recommended defaults
// changed to similarity_boost: 1.0 / style: 0.0 — otherwise a browser that had
// already saved the old 0.85/0.3 defaults would silently keep using them forever,
// making that change look like it did nothing.
const STORAGE_KEY_VOICE_SETTINGS = "echovoice.voiceSettings.v2";

function loadPersistedVoiceSettings() {
  try {
    const savedSettings = JSON.parse(localStorage.getItem(STORAGE_KEY_VOICE_SETTINGS) || "null");
    if (savedSettings) {
      stabilityInput.value = savedSettings.stability;
      similarityInput.value = savedSettings.similarity_boost;
      styleInput.value = savedSettings.style;
    }
  } catch {
    // Corrupt/blocked localStorage shouldn't break the app — just use the HTML defaults.
  }
}

function currentVoiceSettings() {
  return {
    stability: parseFloat(stabilityInput.value),
    similarity_boost: parseFloat(similarityInput.value),
    style: parseFloat(styleInput.value),
  };
}

function persistVoiceSettings() {
  try {
    localStorage.setItem(STORAGE_KEY_VOICE_SETTINGS, JSON.stringify(currentVoiceSettings()));
  } catch {
    // Best-effort — non-critical.
  }
}

loadPersistedVoiceSettings();

function updateSliderReadouts() {
  stabilityValue.textContent = parseFloat(stabilityInput.value).toFixed(2);
  similarityValue.textContent = parseFloat(similarityInput.value).toFixed(2);
  styleValue.textContent = parseFloat(styleInput.value).toFixed(2);
}
updateSliderReadouts();

for (const slider of [stabilityInput, similarityInput, styleInput]) {
  slider.addEventListener("input", () => {
    updateSliderReadouts();
    persistVoiceSettings();
  });
}

function updateGenerateAvailability() {
  generateBtn.disabled = !(currentVoiceId && scriptInput.value.trim());
}

scriptInput.addEventListener("input", () => {
  updateGenerateAvailability();
  scriptCharCount.textContent = String(scriptInput.value.length);
});

generateBtn.addEventListener("click", async () => {
  const text = scriptInput.value.trim();

  hideErrorRecovery(); // clear any leftover error UI from a previous attempt
  generateBtn.disabled = true;
  playbackCard.hidden = true;
  generateLoading.hidden = false;
  const stopLoader = startBreathingLoader(generateLoadingCanvas, { color: "#e4f222" });

  try {
    const { url, voiceId, modelUsed } = await synthesizeSpeech(text, null, {
      languageCode: languageSelect.value,
      modelId: modelSelect.value,
      voiceSettings: currentVoiceSettings(),
      fallbackVoiceId: currentVoiceId,
    });

    resultPlayback.src = url;
    resultPlayback.play();
    currentVoiceId = voiceId;
    await setupPlaybackCard(url);
    showToast({ message: `Generated your ideal delivery. (model: ${modelUsed})`, type: "success" });

    // Don't block playback on this — it's a bonus visual, audio should start right away.
    renderPitchViz(url, getLastAlignment(), resultPlayback);

    // A new AI line invalidates any previous "Now you try" comparison (it was
    // for a different script/audio) — reset that section and reveal it fresh.
    comparisonSection.hidden = false;
    comparisonScriptText.textContent = text;
    comparisonPlayback.hidden = true;
    comparisonPlayback.removeAttribute("src");
    comparisonStatus.textContent = "";
    comparisonRecordBtn.textContent = "🎤";
    comparisonRecordBtn.setAttribute("aria-label", "Record Your Attempt");
    comparisonRecordBtn.classList.remove("recording");
    comparisonCompareBtn.disabled = true;
    comparisonControls.hidden = true;
    tryAgainBtn.hidden = true;
    transportMode = null;
    resetComparisonViz();
  } catch (err) {
    if (err && err.code === "voice_not_found") {
      // Self-heal: the stored voice_id is stale (e.g. the server was restarted
      // and swept it, or it was deleted directly in ElevenLabs). Clear it
      // everywhere so the app doesn't keep retrying a dead ID, and guide the
      // user straight back to voice setup instead of showing an API error.
      currentVoiceId = null;
      invalidateVoice();
      showErrorRecovery(friendlyErrorMessage(err));
    } else {
      showToast({ message: friendlyErrorMessage(err), type: "error" });
    }
  } finally {
    stopLoader();
    generateLoading.hidden = true;
    updateGenerateAvailability();
  }
});

comparisonRecordBtn.addEventListener("click", async () => {
  if (comparisonRecorder.isRecording) {
    const blob = await comparisonRecorder.stop();
    onComparisonRecordingStopped(blob);
    return;
  }

  try {
    comparisonStatus.textContent = "Requesting microphone access...";
    await comparisonRecorder.start(onComparisonRecordingStopped); // auto-stops at 90s
    comparisonRecordBtn.textContent = "■";
    comparisonRecordBtn.setAttribute("aria-label", "Stop Recording");
    comparisonRecordBtn.classList.add("recording");
    comparisonStatus.textContent = "Recording... read the line back (auto-stops at 90s)";
  } catch (err) {
    comparisonStatus.textContent = `Couldn't access microphone: ${err.message}`;
  }
});

function onComparisonRecordingStopped(blob) {
  comparisonRecordBtn.textContent = "🎤";
  comparisonRecordBtn.setAttribute("aria-label", "Record Your Attempt");
  comparisonRecordBtn.classList.remove("recording");
  comparisonStatus.textContent = "Got it — hit Compare when you're ready.";

  const userUrl = URL.createObjectURL(blob);
  comparisonPlayback.src = userUrl;
  comparisonPlayback.hidden = false;
  comparisonCompareBtn.disabled = false;

  // A new attempt invalidates whatever comparison was showing before.
  resetComparisonViz();
  comparisonControls.hidden = true;
  tryAgainBtn.hidden = true;
  transportMode = null;
}

comparisonCompareBtn.addEventListener("click", async () => {
  comparisonCompareBtn.disabled = true;
  comparisonStatus.textContent = "Comparing...";
  comparisonControls.hidden = false;
  tryAgainBtn.hidden = false;
  transportMode = null;

  const result = await compareDeliveries({
    aiUrl: resultPlayback.src,
    userUrl: comparisonPlayback.src,
    scriptText: comparisonScriptText.textContent,
  });
  comparisonStatus.textContent = result ? `Done — ${result.score}% match.` : "Done.";
  comparisonCompareBtn.disabled = false;
});

tryAgainBtn.addEventListener("click", () => {
  resultPlayback.pause();
  comparisonPlayback.pause();
  comparisonPlayback.hidden = true;
  comparisonPlayback.removeAttribute("src");
  comparisonStatus.textContent = "";
  comparisonCompareBtn.disabled = true;
  comparisonControls.hidden = true;
  tryAgainBtn.hidden = true;
  transportMode = null;
  resetComparisonViz();
});

backupBtn.addEventListener("click", () => {
  const clip = BACKUP_CLIPS[backupIndex % BACKUP_CLIPS.length];
  backupIndex++;
  resultPlayback.src = clip;
  setupPlaybackCard(clip);
  resultPlayback.play().catch(() => {
    showToast({ message: `Couldn't play ${clip} — make sure it exists in backup-audio/. Try again, or use a different clip.`, type: "error" });
  });
});

updateGenerateAvailability();

// Everything above ran without throwing — the app is actually functional now.
hideLoadingOverlay();
