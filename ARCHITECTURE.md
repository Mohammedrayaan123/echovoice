# EchoVoice architecture

## Browser boundary

Browser modules remain under `public/js/`. `tts.js` talks only to EchoVoice routes:

- `POST /api/clone-voice`
- `POST /api/preview-voice`
- `POST /api/synthesize` for retained ElevenLabs synthesis
- `POST /api/plan-delivery`
- `POST /api/generate-ideal`

The browser never imports `@gradio/client`, contacts the OmniVoice Space, or receives API keys, provider URLs, queue identifiers, inference controls, or stack traces.

`app.js` keeps one provider-agnostic handoff: the returned audio becomes `referenceUrl`. `comparisonViz.js` receives that URL as `aiUrl`, as it did before this change. `comparisonViz.js`, `pitchUtils.js`, Pitchy, semitone comparison, and transport controls are unchanged.

## Server modules

- `server/config.js`: validated environment configuration and defaults.
- `server/elevenLabsClient.js`: stock-voice reference reading with timestamps and audio-duration fallback parsing.
- `server/deliveryPlanner.js`: mode profiles, input validation, measurement, instruction text, and speed mapping.
- `server/omniVoiceClient.js`: server-only Gradio client, one `/_clone_fn` submission, hard timeout, output validation, and download.
- `server/voiceProfileStore.js`: private raw reference and transcript storage using generated profile IDs and server-controlled paths.
- `server/idealGenerationService.js`: short-lived plan records, provider switch, final audio contract, and backup lookup.
- `server/backupClips.js`: deterministic safe filenames and exact script-plus-mode lookup.
- `server/audioLogger.js`: existing best-effort Supabase/local logging pattern shared by browser uploads and server-generated audio.

## Route contracts

### `POST /api/clone-voice`

Input is multipart audio, a voice name, and the exact reference transcript. In Omni mode, setup requires one original recording and a nonempty transcript, stores them privately, and returns an opaque local `voiceId`, a `voiceProfileId`, and `requiresVerification=false`. Setup makes no ElevenLabs clone or API call. In ElevenLabs mode, setup retains the existing clone request and real ElevenLabs voice ID.

### `POST /api/preview-voice`

Input is `{ text, voiceId, voiceProfileId, languageCode }`. Omni mode loads the saved raw reference and transcript, then generates one neutral preview with `instruct=""`, `sp=1`, and `du=null`. No delivery plan or ElevenLabs reference reading runs. The usual Omni hard timeout applies and the request is not retried. ElevenLabs mode uses the saved real voice ID with `eleven_multilingual_v2`. Both paths return `audioBase64`, `mimeType`, and `alignment` in the usual audio contract.

### `POST /api/plan-delivery`

Input:

```json
{ "script": "...", "mode": "interview" }
```

Omni mode generates the ElevenLabs measurement reference once, logs it, and returns:

```json
{
  "plannerId": "opaque-id",
  "instruction": "...",
  "targetDuration": 18.2,
  "targetSpeed": 0.98,
  "measuredWpm": 128
}
```

Plans expire after ten minutes and are consumed by one generation request. The script and mode must match the planned values.
Plans currently live in process memory. Multi-instance hosting therefore needs sticky routing or a shared plan store.

Successful reference-plan metadata is cached for five minutes, keyed by the exact trimmed script and mode, with a maximum of 64 entries per process. Concurrent matching calls share the pending reference reading; each caller still gets an independent single-use plan ID. Failures are removed immediately. Raw voice samples and final generated audio are never part of this shared cache.

The browser retains its current reference until it is replaced or the voice changes. An exact match of script, mode, voice/profile and voice settings enables immediate replay. New generation is a separate explicit action. Inputs are locked during generation to keep the requested script and settings consistent. Script drafts are saved locally; read-along pitch extraction starts when its panel is opened.

### `POST /api/generate-ideal`

Input includes the script, mode, planner ID, opaque voice handle, private voice-profile ID, and the retained ElevenLabs settings for operator switchback. The handle is local for newly captured Omni profiles and an ElevenLabs voice ID for ElevenLabs clones. Switching to ElevenLabs requires setup again for a local Omni profile; existing real ElevenLabs voices remain usable.

Success uses one provider-neutral audio contract:

```json
{
  "success": true,
  "audioBase64": "...",
  "mimeType": "audio/wav",
  "alignment": null
}
```

An Omni failure includes safe backup metadata when an exact match exists:

```json
{
  "success": false,
  "code": "OMNI_TIMEOUT",
  "errorCode": "OMNI_TIMEOUT",
  "error": "Voice generation is taking longer than expected.",
  "backupAvailable": true,
  "backupUrl": "/backup-clips/..."
}
```

## Planning calculations

1. Generate one stock-voice ElevenLabs reading of the script.
2. Use the final character timestamp as the duration. If timestamps are absent, parse the returned MP3 duration.
3. Count whitespace-separated words.
4. Calculate `measuredWpm = round(wordCount / (durationSeconds / 60))`.
5. Set `targetDuration` to the measured duration rounded to one decimal place.
6. Calculate `targetSpeed = clamp(measuredWpm / 135, 0.85, 1.15)`, rounded to two decimals.
7. Build the EchoVoice delivery instruction from the selected fixed profile:

```text
{style}. {pause guidance}. {emphasis guidance}. Target approximately {targetDuration to 1 decimal} seconds overall.
```

Example:

```text
Speak calmly and confidently in a conversational interview style. Use brief natural pauses after major ideas. Add moderate emphasis to key points. Target approximately 18.2 seconds overall.
```

The public OmniVoice Space currently validates `instruct` as speaker-design tags only (gender, age, pitch, whisper, or accent). It rejects natural delivery prose. EchoVoice retains the readable delivery instruction in its plan but sends an empty `instruct` value during voice cloning to preserve the captured voice instead of guessing speaker attributes. EchoVoice also sends `du=null`: OmniVoice documents that a fixed duration overrides speed, and forcing the measured ElevenLabs duration can compress the speech token budget enough to corrupt words. The bounded `sp` value guides pace while OmniVoice estimates sufficient output duration.

No optimization loop runs. Omni receives one request.

## Omni request

`server/omniVoiceClient.js` connects to `OMNI_SPACE_ID` with the optional server-only `HUGGINGFACE_TOKEN`, submits `/_clone_fn`, and sends:

```text
text, lang, ref_aud, ref_text, instruct, ns, gs, dn, sp, du, pp, po
```

Defaults are `lang=Auto`, `ns=32`, `gs=2.0`, `dn=true`, `pp=true`, and `po=true`. `sp` and `du` come from the planner. The hard timeout defaults to 40 seconds and covers connection, queueing, generation, and output download. The timed-out job is cancelled and is not retried.

## Voice capture and privacy

The existing recorder still requests raw capture with `echoCancellation=false`, `noiseSuppression=false`, and `autoGainControl=false`. Voice setup asks for a 7–10 second recording and review of the exact spoken transcript. The original uploaded bytes and transcript are stored outside `public/` under a generated profile ID. User filenames never become server paths.

The ElevenLabs API key is server-only. The raw profile store and `.env` are ignored by Git. Audio logging remains optional and best-effort; remote or local logging failure does not fail rehearsal generation.
