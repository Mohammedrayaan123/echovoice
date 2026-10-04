// Coordinates the rehearsal session; capture and synthesis own their audio work.
import { generateIdealSpeech, planIdealDelivery, getLastAlignment } from './tts.js';
import { init as initPitchViz, render as renderPitchViz, reset as resetPitchViz } from './pitchViz.js';
import { init as initComparisonViz, compare as compareDeliveries, setPlayhead, reset as resetComparisonViz, redraw as redrawComparison } from './comparisonViz.js';
import { init as initVoiceCapture, invalidateVoice, openModal } from './voiceCapture.js';
import { VoiceRecorder } from './recorder.js';
import { friendlyErrorMessage } from './errorMessages.js';
import { showToast } from './toast.js';
import { drawRibbon, sampleAudioBufferPeaks, decodeAudioBufferFromUrl, startBreathingLoader, observeCanvasResize, startLiveRibbon } from './waveformRibbon.js';

const $ = id => document.getElementById(id);
const scriptInput = $('script-input');
const generateBtn = $('generate-btn');
const resultPlayback = $('result-playback');
const attemptPlayback = $('comparison-playback');
const recordBtn = $('comparison-record-btn');
const compareBtn = $('comparison-compare-btn');
const status = $('comparison-status');
const modelSelect = $('model-select');
const languageSelect = $('language-select');
const sliders = { stability: $('stability-input'), similarity_boost: $('similarity-input'), style: $('style-input') };
const recorder = new VoiceRecorder({ logType: 'user-attempt', maxDurationMs: 90_000 });
const STORAGE_KEY = 'echovoice.voiceSettings.v3';
const icons = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
};
let voiceId = null;
let voiceProfileId = null;
let generating = false;
let comparing = false;
let requestingMic = false;
let generationVersion = 0;
let comparisonVersion = 0;
let referenceUrl = null;
let attemptUrl = null;
let referenceAlignment = null;
let transportMode = 'reference';
let playheadRaf = null;
let recordingTimer = null;
let liveRibbon = null;
let playbackPeaks = null;
let matchingBackup = null;
let modesReady = false;
let dismissGenerationError = null;
let tokenUpdateEnabled = false;
let referenceKey = null;
let readAlongUrl = null;
let draftTimer;
const DRAFT_KEY = 'echovoice.scriptDraft';
function requestSnapshot() {
  return { script: scriptInput.value.trim(), mode: selectedDeliveryMode(), voiceId, voiceProfileId,
    modelId: modelSelect.value, languageCode: languageSelect.disabled ? '' : languageSelect.value, voiceSettings: voiceSettings() };
}
function currentReference() { return Boolean(referenceUrl && referenceKey === JSON.stringify(requestSnapshot())); }

function iconButton(el, icon, label) {
  el.innerHTML = icons[icon];
  el.setAttribute('aria-label', label);
  el.title = label;
}
function text(id, value) { if ($(id)) $(id).textContent = value; }
function clock(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(Math.floor(safe % 60)).padStart(2, '0')}`;
}
function release(url) { if (url?.startsWith('blob:')) URL.revokeObjectURL(url); }
function stopAllPlayback() { resultPlayback.pause(); attemptPlayback.pause(); }
async function play(audio) {
  try { await audio.play(); }
  catch (err) {
    if (err.name !== 'AbortError') showToast({ message: 'Press play to listen. If the clip still will not play, generate it again.', type: 'info' });
  }
}
function updateAvailability() {
  const recording = recorder.isRecording || requestingMic;
  generateBtn.disabled = !modesReady || !voiceId || !scriptInput.value.trim() || generating || recording || comparing;
  recordBtn.disabled = generating || comparing || requestingMic;
  compareBtn.disabled = !attemptUrl || !referenceUrl || recording || generating || comparing;
  const reusable = currentReference();
  generateBtn.textContent = generating ? 'Creating your track…' : reusable ? 'Listen again' : referenceUrl ? 'Hear updated words' : 'Hear my words';
  $('regenerate-btn').hidden = !reusable;
  $('regenerate-btn').disabled = generating || recording || comparing;
  $('reference-change-note').hidden = !referenceUrl || reusable;
  $('backup-btn').hidden = !matchingBackup || matchingBackup.key !== JSON.stringify(requestSnapshot());
  text('generation-hint', generating ? 'Creating your practice track. Follow the progress below.' : !voiceId ? 'Set up your voice to hear your script.' : !scriptInput.value.trim() ? 'Add a script or choose a starting point.' : reusable ? 'Replay your current track without generating again.' : referenceUrl ? 'Create a matching track for your updated words or settings.' : 'Ready to hear your script in your voice.');
  text('session-state', recording ? 'Recording' : generating ? 'Creating reference' : voiceId ? 'Voice ready' : 'Your practice space');
  const step = !voiceId ? 'voice' : referenceUrl ? 'practice' : 'script';
  for (const name of ['voice', 'script', 'practice']) {
    const link = $(`journey-${name}`);
    link?.classList.toggle('is-current', name === step);
    if (name === step) link?.setAttribute('aria-current', 'step');
    else link?.removeAttribute('aria-current');
  }
}
function resetAttempt() {
  comparisonVersion++;
  comparing = false;
  attemptPlayback.pause();
  attemptPlayback.removeAttribute('src');
  attemptPlayback.load();
  release(attemptUrl);
  attemptUrl = null;
  attemptPlayback.hidden = true;
  $('comparison-controls').hidden = true;
  $('try-again-btn').hidden = true;
  status.textContent = '';
  resetComparisonViz();
  updateAvailability();
}
function invalidateReference() {
  generationVersion++;
  stopAllPlayback();
  resetAttempt();
  resultPlayback.removeAttribute('src');
  resultPlayback.load();
  release(referenceUrl);
  referenceUrl = null;
  referenceKey = null;
  readAlongUrl = null;
  referenceAlignment = null;
  matchingBackup = null;
  $('backup-btn').hidden = true;
  $('playback-card').hidden = true;
  $('comparison-section').hidden = true;
  if ($('rehearsal-empty')) $('rehearsal-empty').hidden = false;
  resetPitchViz();
}

function selectedDeliveryMode() {
  return document.querySelector('input[name="delivery-mode"]:checked')?.value || 'interview';
}

async function loadStudioConfig() {
  const container = $('delivery-mode-options');
  try {
    const response = await fetch('/api/studio-config');
    const config = await response.json();
    if (!response.ok || !Array.isArray(config.deliveryModes) || !config.deliveryModes.length) throw new Error('invalid config');
    container.replaceChildren(...config.deliveryModes.map(mode => {
      const label = document.createElement('label');
      label.className = 'delivery-mode-option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'delivery-mode';
      input.value = mode.id;
      input.checked = mode.id === config.defaultDeliveryMode;
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      const description = document.createElement('small');
      title.textContent = mode.label;
      description.textContent = mode.description;
      copy.append(title, description);
      label.append(input, copy);
      input.addEventListener('change', updateAvailability);
      return label;
    }));
    if (!container.querySelector('input:checked')) container.querySelector('input').checked = true;
    if (Number.isInteger(config.maxScriptLength) && config.maxScriptLength > 0) {
      scriptInput.maxLength = config.maxScriptLength;
      const limit = document.querySelector('.char-limit');
      if (limit) limit.textContent = ` / ${config.maxScriptLength.toLocaleString()}`;
    }
    // These controls configure the retained ElevenLabs-only path. Hide them
    // when the active generation backend does not consume those settings.
    $('script-settings').hidden = config.voiceModelControlsEnabled !== true;
    tokenUpdateEnabled = config.tokenUpdateEnabled === true;
    modesReady = true;
  } catch {
    container.textContent = 'Delivery modes could not be loaded. Reload the page to try again.';
  }
  updateAvailability();
}

initPitchViz($('pitch-viz'));
initComparisonViz({
  idealCanvas: $('comparison-canvas-ideal'), attemptCanvas: $('comparison-canvas-attempt'),
  messageEl: $('comparison-message'), panelsEl: $('comparison-panels'), resultsEl: $('comparison-results'),
  scoreRingEl: $('score-circle-ring'), scoreNumberEl: $('score-circle-number'), scoreTierLabelEl: $('score-tier-label'),
  feedbackCardsEl: $('feedback-cards'), scriptHighlightCardEl: $('script-highlight-card'), scriptHighlightWordsEl: $('script-highlight-words'),
  detailToggleBtn: $('detail-toggle-btn'), detailCollapseEl: $('detail-collapse'),
});

$('detail-toggle-btn').addEventListener('click', () => {
  const expanded = $('detail-collapse').classList.toggle('detail-collapse-expanded');
  $('detail-toggle-btn').textContent = expanded ? 'Hide pitch details −' : 'Explore pitch details +';
  $('detail-toggle-btn').setAttribute('aria-expanded', String(expanded));
  if (expanded) requestAnimationFrame(redrawComparison);
});
$('error-recovery-btn').addEventListener('click', () => { $('error-recovery').hidden = true; openModal(); });
$('error-recovery-dismiss').addEventListener('click', () => { $('error-recovery').hidden = true; });

function voiceSettings() {
  return Object.fromEntries(Object.entries(sliders).map(([key, input]) => [key, Number(input.value)]));
}
function readouts() {
  text('stability-value', modelSelect.value === 'eleven_v3' ? ({0:'Creative', 0.5:'Natural', 1:'Robust'}[Number(sliders.stability.value)] || 'Natural') : Number(sliders.stability.value).toFixed(2));
  text('similarity-value', Number(sliders.similarity_boost.value).toFixed(2));
  text('style-value', Number(sliders.style.value).toFixed(2));
}
try {
  const settings = JSON.parse(localStorage.getItem(STORAGE_KEY));
  for (const [key, input] of Object.entries(sliders)) {
    if (typeof settings?.[key] === 'number' && Number.isFinite(settings[key])) input.value = Math.max(0, Math.min(1, settings[key]));
  }
} catch { /* Local preferences are optional. */ }
function syncModelSettings() {
  const v3 = modelSelect.value === 'eleven_v3';
  const flash = modelSelect.value === 'eleven_flash_v2_5';
  sliders.stability.step = v3 ? '0.5' : '0.05';
  if (v3) sliders.stability.value = String(Math.round(Number(sliders.stability.value) * 2) / 2);
  for (const input of [sliders.similarity_boost, sliders.style]) {
    const unsupported = v3 || (input === sliders.style && flash);
    input.disabled = unsupported;
    const row = input.closest('.slider-row');
    if (row) row.hidden = unsupported;
  }
  languageSelect.disabled = !flash && !v3;
  text('language-hint', flash || v3 ? 'Choose the language you will rehearse in. Your accent comes from your voice sample.' : 'Language follows your script. Record your voice sample in the language and accent you normally use.');
  text('model-settings-note', v3 ? 'Natural stays closest to the recording. Creative can change the delivery more. Similarity and style controls are unavailable in this mode.' : 'Start with these balanced settings. A clean voice sample matters more than pushing similarity to maximum.');
  readouts();
}
modelSelect.addEventListener('change', () => { syncModelSettings(); updateAvailability(); });
languageSelect.addEventListener('change', updateAvailability);
for (const slider of Object.values(sliders)) slider.addEventListener('input', () => {
  readouts();
  updateAvailability();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(voiceSettings())); } catch { /* Optional. */ }
});
syncModelSettings();
function updateScript() {
  text('script-char-count', String(scriptInput.value.length));
  const words = scriptInput.value.trim().split(/\s+/).filter(Boolean).length;
  const seconds = Math.max(1, Math.round(words / 2.3));
  text('script-duration', words ? `${words} ${words === 1 ? 'word' : 'words'} · about ${seconds} ${seconds === 1 ? 'second' : 'seconds'}` : 'Make it sound like you');
  document.querySelectorAll('[data-script-preset]').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.scriptPreset === scriptInput.value)));
  updateAvailability();
}
function saveDraft() {
  clearTimeout(draftTimer);
  try { localStorage.setItem(DRAFT_KEY, scriptInput.value); text('script-draft-status', 'Draft saved on this device'); }
  catch { text('script-draft-status', 'Draft available until you close this page'); }
}
try { scriptInput.value = localStorage.getItem(DRAFT_KEY) || ''; } catch { /* Optional local draft. */ }
scriptInput.addEventListener('input', () => {
  updateScript();
  text('script-draft-status', 'Saving draft…');
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 350);
});
scriptInput.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); generateBtn.click(); }
});
for (const btn of document.querySelectorAll('[data-script-preset]')) btn.addEventListener('click', () => {
  scriptInput.value = btn.dataset.scriptPreset;
  updateScript();
  saveDraft();
  scriptInput.focus();
});

function redrawPlayback() { if (playbackPeaks) drawRibbon($('playback-waveform'), playbackPeaks, { color: '#e4f222' }); }
// Pitch extraction is optional work: start it when the listener opens the map.
function prepareReadAlong() {
  if (generating || !referenceUrl || !document.querySelector('.delivery-map').open || readAlongUrl === referenceUrl) return;
  if (!referenceAlignment && (!Number.isFinite(resultPlayback.duration) || resultPlayback.duration <= 0)) return;
  readAlongUrl = referenceUrl;
  renderPitchViz(referenceUrl, referenceAlignment, resultPlayback, $('comparison-script-text').textContent);
}
document.querySelector('.delivery-map').addEventListener('toggle', prepareReadAlong);
resultPlayback.addEventListener('loadedmetadata', prepareReadAlong);
observeCanvasResize($('playback-waveform'), redrawPlayback);
async function setupPlayback(url) {
  $('playback-card').hidden = false;
  playbackPeaks = null;
  iconButton($('playback-play-btn'), 'play', 'Play reference');
  $('playback-progress-fill').style.transform = 'scaleX(0)';
  text('playback-time', '00:00 / 00:00');
  try {
    const buffer = await decodeAudioBufferFromUrl(url);
    if (url !== referenceUrl) return;
    playbackPeaks = sampleAudioBufferPeaks(buffer, 200);
    redrawPlayback();
    text('playback-time', `00:00 / ${clock(buffer.duration)}`);
  } catch { /* Playback works independently of the waveform. */ }
}
$('playback-play-btn').addEventListener('click', () => {
  if (resultPlayback.paused) { attemptPlayback.pause(); play(resultPlayback); }
  else resultPlayback.pause();
});
resultPlayback.addEventListener('timeupdate', () => {
  const duration = resultPlayback.duration;
  if (!Number.isFinite(duration) || !duration) return;
  $('playback-progress-fill').style.transform = `scaleX(${resultPlayback.currentTime / duration})`;
  text('playback-time', `${clock(resultPlayback.currentTime)} / ${clock(duration)}`);
});
function activeAudios() { return transportMode === 'both' ? [resultPlayback, attemptPlayback] : [transportMode === 'attempt' ? attemptPlayback : resultPlayback]; }
function playing(audio) { return !audio.paused && !audio.ended; }
function tickPlayhead() {
  const active = [resultPlayback, attemptPlayback].find(playing);
  setPlayhead(active ? active.currentTime : null);
  iconButton($('play-pause-btn'), active ? 'pause' : 'play', active ? 'Pause playback' : 'Play selected audio');
  if (active) playheadRaf = requestAnimationFrame(tickPlayhead);
}
for (const audio of [resultPlayback, attemptPlayback]) for (const event of ['play','pause','ended']) audio.addEventListener(event, () => {
  iconButton($('playback-play-btn'), playing(resultPlayback) ? 'pause' : 'play', playing(resultPlayback) ? 'Pause reference' : 'Play reference');
  cancelAnimationFrame(playheadRaf);
  if (!$('comparison-controls').hidden) tickPlayhead();
});
for (const [id, mode] of [['play-ideal-btn','reference'], ['play-yours-btn','attempt'], ['play-both-btn','both']]) $(id).addEventListener('click', () => {
  stopAllPlayback();
  transportMode = mode;
  for (const audio of activeAudios()) { audio.currentTime = 0; audio.volume = mode === 'both' && audio === attemptPlayback ? 0.7 : 1; play(audio); }
});
$('play-pause-btn').addEventListener('click', () => {
  const targets = activeAudios();
  if (targets.some(playing)) targets.forEach(audio => audio.pause());
  else targets.forEach(audio => play(audio));
});
for (const [id, delta] of [['skip-back-btn',-5],['skip-fwd-btn',5]]) $(id).addEventListener('click', () => {
  for (const audio of activeAudios()) if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, Math.max(0, audio.currentTime + delta));
});
for (const btn of document.querySelectorAll('.speed-btn')) btn.addEventListener('click', () => {
  resultPlayback.playbackRate = attemptPlayback.playbackRate = Number(btn.dataset.speed);
  document.querySelectorAll('.speed-btn').forEach(el => { el.classList.toggle('active', el === btn); el.setAttribute('aria-pressed', String(el === btn)); });
});

async function generateReference(force = false) {
  if (generateBtn.disabled || generating) return;
  if (!force && currentReference()) { stopAllPlayback(); resultPlayback.currentTime = 0; play(resultPlayback); return; }
  const snapshot = requestSnapshot();
  const { script, mode } = snapshot;
  const version = ++generationVersion;
  const requestedVoice = voiceId;
  const requestedProfile = voiceProfileId;
  generating = true;
  const lockedControls = [scriptInput, ...document.querySelectorAll('input[name="delivery-mode"], [data-script-preset], #script-settings input, #script-settings select')];
  const disabledBefore = lockedControls.map(control => control.disabled);
  lockedControls.forEach(control => { control.disabled = true; });
  const started = Date.now();
  const progressTimer = setInterval(() => text('generation-elapsed', `${Math.floor((Date.now() - started) / 1000)}s elapsed`), 1000);
  text('generation-elapsed', '0s elapsed');
  $('generation-stage-plan').className = 'is-active';
  $('generation-stage-voice').className = '';
  stopAllPlayback();
  $('error-recovery').hidden = true;
  $('generate-loading').hidden = false;
  text('generate-loading-label', 'Planning your ideal delivery...');
  text('generate-loading-detail', 'Measuring a reference reading to guide the pace.');
  dismissGenerationError?.();
  dismissGenerationError = null;
  matchingBackup = null;
  $('backup-btn').hidden = true;
  generateBtn.setAttribute('aria-busy', 'true');
  updateAvailability();
  const stopLoader = startBreathingLoader($('generate-loading-canvas'), { color: '#e4f222' });
  try {
    const plan = await planIdealDelivery(script, mode);
    if (version !== generationVersion || requestedVoice !== voiceId) return;
    text('generate-loading-label', 'Generating in your voice...');
    $('generation-stage-plan').className = 'is-complete';
    $('generation-stage-voice').className = 'is-active';
    text('generate-loading-detail', 'Using your original recording and transcript. You can stay on this page while it finishes.');
    const result = await generateIdealSpeech({
      script, mode, plannerId: plan.plannerId, voiceId: requestedVoice, voiceProfileId: requestedProfile,
      modelId: snapshot.modelId, languageCode: snapshot.languageCode, voiceSettings: snapshot.voiceSettings,
    });
    if (version !== generationVersion || requestedVoice !== voiceId) { release(result.url); return; }
    resetAttempt();
    release(referenceUrl);
    referenceUrl = result.url;
    referenceKey = JSON.stringify(snapshot);
    referenceAlignment = result.alignment || getLastAlignment();
    resultPlayback.src = referenceUrl;
    resultPlayback.load();
    $('comparison-script-text').textContent = script;
    $('comparison-section').hidden = false;
    if ($('rehearsal-empty')) $('rehearsal-empty').hidden = true;
    await setupPlayback(referenceUrl);
    const length = resultPlayback.duration;
    recorder.maxDurationMs = Number.isFinite(length) ? Math.max(90_000, Math.ceil(length * 1.5 + 10) * 1000) : 300_000;
    if (version !== generationVersion) return;
    play(resultPlayback);
    resetPitchViz();
    readAlongUrl = null;
    prepareReadAlong();
    showToast({ message: 'Your reference is ready. Listen, then make it your own.', type: 'success' });
  } catch (err) {
    if (version !== generationVersion) return;
    if (err.backupAvailable && err.backupUrl) {
      matchingBackup = { url: err.backupUrl, script, key: JSON.stringify(snapshot) };
      $('backup-btn').textContent = 'Use backup clip';
      $('backup-btn').hidden = false;
    }
    if (['voice_not_found', 'missing_voice_sample', 'missing_reference_transcript'].includes(err.code)) {
      if (err.code === 'voice_not_found') invalidateVoice();
      $('error-recovery-message').textContent = friendlyErrorMessage(err);
      $('error-recovery').hidden = false;
    }
    dismissGenerationError = showToast({ message: friendlyErrorMessage(err), type: 'error' });
  } finally {
    generating = false;
    clearInterval(progressTimer);
    lockedControls.forEach((control, index) => { control.disabled = disabledBefore[index]; });
    stopLoader();
    $('generate-loading').hidden = true;
    generateBtn.removeAttribute('aria-busy');
    updateAvailability();
    prepareReadAlong();
  }
}
generateBtn.addEventListener('click', () => generateReference());
$('regenerate-btn').addEventListener('click', () => generateReference(true));

function finishRecordingUI() {
  clearInterval(recordingTimer);
  liveRibbon?.stopImmediately();
  liveRibbon = null;
  iconButton(recordBtn, 'mic', 'Record your attempt');
  recordBtn.classList.remove('recording');
}
function recordingStopped(blob) {
  finishRecordingUI();
  if (!blob?.size) { status.textContent = 'No audio was captured. Please try again.'; updateAvailability(); return; }
  release(attemptUrl);
  attemptUrl = URL.createObjectURL(blob);
  attemptPlayback.src = attemptUrl;
  attemptPlayback.load();
  attemptPlayback.hidden = false;
  status.textContent = 'Take captured. Listen back or compare your pitch.';
  updateAvailability();
}
recordBtn.addEventListener('click', async () => {
  if (requestingMic || generating || comparing) return;
  if (recorder.isRecording) { recordBtn.disabled = true; recordingStopped(await recorder.stop()); return; }
  requestingMic = true;
  stopAllPlayback();
  resetAttempt();
  status.textContent = 'Connecting to your microphone…';
  updateAvailability();
  try {
    await recorder.start(recordingStopped);
    if (!recorder.isRecording) return;
    iconButton(recordBtn, 'stop', 'Stop recording');
    recordBtn.classList.add('recording');
    const updateTimer = () => { status.textContent = `Recording ${clock(recorder.elapsedMs / 1000)} / ${clock(recorder.maxDurationMs / 1000)} · Read at your natural pace`; };
    updateTimer();
    recordingTimer = setInterval(updateTimer, 200);
    if ($('attempt-waveform')) {
      try { liveRibbon = startLiveRibbon(recorder.liveStream, $('attempt-waveform'), { color: '#aebcc7' }); } catch { /* Optional visualization. */ }
    }
  } catch (err) {
    finishRecordingUI();
    status.textContent = err.name === 'NotAllowedError' ? 'Microphone access was declined. Allow it in your browser and try again.' : 'Could not open your microphone. Check that it is connected and try again.';
  } finally { requestingMic = false; updateAvailability(); }
});
compareBtn.addEventListener('click', async () => {
  if (compareBtn.disabled) return;
  comparing = true;
  const version = ++comparisonVersion;
  stopAllPlayback();
  updateAvailability();
  status.textContent = 'Listening for pitch patterns…';
  $('comparison-controls').hidden = false;
  $('try-again-btn').hidden = false;
  const result = await compareDeliveries({ aiUrl: referenceUrl, userUrl: attemptUrl, scriptText: $('comparison-script-text').textContent, alignment: referenceAlignment });
  if (version !== comparisonVersion) return;
  status.textContent = result ? `${result.score}% pitch match across the compared audio. This is practice feedback, not a measure of voice likeness.` : 'Listen to both clips, or record another take for clearer feedback.';
  comparing = false;
  updateAvailability();
});
$('try-again-btn').addEventListener('click', () => { stopAllPlayback(); resetAttempt(); recordBtn.focus(); });

$('backup-btn').hidden = true;
$('backup-btn').addEventListener('click', async () => {
  if (!matchingBackup || generating || recorder.isRecording) return;
  const backup = matchingBackup;
  dismissGenerationError?.();
  dismissGenerationError = null;
  invalidateReference();
  referenceUrl = backup.url;
  referenceKey = backup.key;
  referenceAlignment = null;
  resultPlayback.src = referenceUrl;
  resultPlayback.load();
  $('comparison-script-text').textContent = backup.script;
  $('comparison-section').hidden = false;
  if ($('rehearsal-empty')) $('rehearsal-empty').hidden = true;
  await setupPlayback(referenceUrl);
  const length = resultPlayback.duration;
  recorder.maxDurationMs = Number.isFinite(length) ? Math.max(90_000, Math.ceil(length * 1.5 + 10) * 1000) : 300_000;
  prepareReadAlong();
  play(resultPlayback);
  showToast({ message: 'Using a pre-generated backup clip for this script and delivery mode.', type: 'info' });
  updateAvailability();
});

initVoiceCapture($('capture-container'), (id, profileId) => {
  if (id !== voiceId) invalidateReference();
  voiceId = id;
  voiceProfileId = profileId;
  updateAvailability();
});
document.querySelector('.nav-help')?.addEventListener('click', () => { $('studio-guide').open = true; });
const tokenDialog = $('token-settings-dialog');
const tokenForm = $('token-settings-form');
function closeTokenDialog() {
  tokenDialog.close();
}
tokenDialog.addEventListener('close', () => {
  tokenForm.reset();
  text('token-settings-status', '');
});
function openTokenDialog() {
  text('token-settings-status', '');
  tokenDialog.showModal();
  $('token-admin-key').focus();
}
let brandClickCount = 0;
let brandClickTimer = null;
$('echovoice-brand').addEventListener('click', event => {
  if (!tokenUpdateEnabled) return;
  event.preventDefault();
  brandClickCount += 1;
  clearTimeout(brandClickTimer);
  brandClickTimer = setTimeout(() => { brandClickCount = 0; }, 900);
  if (brandClickCount < 3) return;
  clearTimeout(brandClickTimer);
  brandClickCount = 0;
  openTokenDialog();
});
$('token-settings-close').addEventListener('click', closeTokenDialog);
$('token-settings-cancel').addEventListener('click', closeTokenDialog);
tokenDialog.addEventListener('click', event => { if (event.target === tokenDialog) closeTokenDialog(); });
tokenForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('token-settings-submit');
  submit.disabled = true;
  text('token-settings-status', 'Updating securely…');
  try {
    const response = await fetch('/api/admin/huggingface-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminKey: $('token-admin-key').value, token: $('huggingface-token').value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The token could not be updated.');
    tokenForm.reset();
    text('token-settings-status', 'Token updated. Future generations will use it.');
    showToast({ message: 'Voice access token updated for this server session.', type: 'info' });
  } catch (error) {
    $('huggingface-token').value = '';
    text('token-settings-status', error.message || 'The token could not be updated.');
  } finally {
    submit.disabled = false;
  }
});
document.addEventListener('voice-capture-opening', () => {
  stopAllPlayback();
  if (recorder.isRecording || requestingMic) {
    recorder.cancel();
    requestingMic = false;
    finishRecordingUI();
    status.textContent = 'Recording cancelled while setting up your voice.';
    updateAvailability();
  }
});
window.addEventListener('pagehide', () => { saveDraft(); recorder.cancel(); finishRecordingUI(); release(referenceUrl); release(attemptUrl); });
iconButton(recordBtn, 'mic', 'Record your attempt');
iconButton($('play-pause-btn'), 'play', 'Play selected audio');
loadStudioConfig();
updateScript();
const overlay = $('loading-overlay');
if (overlay) { overlay.classList.add('is-ready'); overlay.style.opacity = '0'; setTimeout(() => { overlay.hidden = true; }, 300); }
