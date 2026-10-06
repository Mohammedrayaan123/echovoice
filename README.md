# EchoVoice

EchoVoice is a voice rehearsal studio. A user creates a voice profile, writes a script, selects a delivery mode, listens to an ideal track in their voice, records a take, and compares pitch and timing with the ideal track.

## Production ideal-generation flow

```text
Script + delivery mode
  -> ElevenLabs stock-voice reference reading
  -> EchoVoice duration, word-count, and pace measurement
  -> EchoVoice delivery-mode instruction
  -> OmniVoice final cloned track
  -> existing EchoVoice comparison and coaching
```

- **ElevenLabs** supplies a short reference performance for measurement. Its audio is logged as `reference-reading`; it is not the track used by the comparison engine.
- **EchoVoice** measures the reference, applies a fixed delivery-mode profile, builds a concise instruction, and continues to own comparison and coaching.
- **OmniVoice** independently generates the final ideal track from the raw voice sample, its transcript, the script, and the plan. Its output is logged as `ideal-omni` and becomes the exact audio compared with the user's attempt.

The planner conveys broad style, approximate pace, duration, pauses, and emphasis inside EchoVoice. It does not transfer exact ElevenLabs prosody or encode word-level performance. The current public OmniVoice Space accepts only speaker-design tags in `instruct`, not delivery prose. EchoVoice therefore leaves that provider field empty during voice cloning so unsupported instructions do not fail generation. EchoVoice retains the measured duration for planning and comparison, while OmniVoice uses the bounded speed target and estimates sufficient output duration to protect word accuracy.

## Local setup

Requirements: Node.js 18 or newer.

```powershell
npm install
Copy-Item .env.example .env
```

Set these values in `.env`:

```dotenv
ELEVENLABS_API_KEY=your_server_side_key
ELEVENLABS_REFERENCE_VOICE_ID=your_premade_stock_voice_id
IDEAL_VOICE_PROVIDER=omni
OMNI_TIMEOUT_MS=40000
OMNI_SPACE_ID=k2-fsa/OmniVoice
HUGGINGFACE_TOKEN=your_optional_server_side_hf_token
TOKEN_ADMIN_KEY=choose_a_private_admin_password
MAX_SCRIPT_LENGTH=3000
DEFAULT_DELIVERY_MODE=interview
```

Then start the app:

```powershell
npm start
```

Open [http://localhost:5500](http://localhost:5500).

The provider keys and Omni connection stay on the server. `HUGGINGFACE_TOKEN` is optional, but recommended because authenticated Hugging Face requests receive a larger ZeroGPU allowance than anonymous requests. `.env`, private raw references, audio logs, and generated backup clips are ignored by Git.

When `TOKEN_ADMIN_KEY` is configured, click the EchoVoice header logo three times within 900 ms to open the private **Voice access** dialog. Enter that admin key and a replacement Hugging Face token to update the running server without editing `.env` or restarting. The replacement is kept only in server memory, is never returned to the browser, and resets to `HUGGINGFACE_TOKEN` after a server restart.

Voice setup records a clean 7–10 second reference and its exact transcript. OmniVoice recommends 3–10 seconds and warns that references over 20 seconds can degrade clone quality; long references can retain vocal identity while reducing word accuracy.

In Omni mode, setup stores one original recording and its reviewed transcript privately without creating an ElevenLabs clone or making an ElevenLabs API call. It returns an opaque local voice handle and reference-profile ID. `/api/preview-voice` generates a neutral Omni preview directly from that reference, without a delivery planner or paid reference reading. Preview makes one attempt under the same Omni timeout as ideal generation.

Microphone capture requests automatic gain for comfortable handheld recording. Quiet captured clips receive a bounded constant volume boost before playback, cloning, and comparison, preserving pitch and timing. Healthy recordings and uploaded files are unchanged. Near-silence is not boosted, and volume adjustment cannot recover missing speech or remove background noise. Record a fresh sample to benefit from this adjustment; saved profiles keep their existing audio.

## Delivery modes

- **Interview:** calm, confident, and conversational.
- **Presentation:** clear, deliberate, and authoritative.
- **Storytelling:** expressive, engaging, and dynamic.
- **Admissions:** warm, thoughtful, sincere, and confident.

The browser loads the labels and descriptions from `/api/studio-config`; the planning profiles and instruction strings live only in `server/deliveryPlanner.js`.

## Emergency ElevenLabs switch

Set the following value and restart the server:

```dotenv
IDEAL_VOICE_PROVIDER=elevenlabs
```

The two frontend generation calls remain the same, while the server uses the existing cloned-voice ElevenLabs synthesis path. Voice setup creates an ElevenLabs clone in this mode, and `/api/preview-voice` auditions it with `eleven_multilingual_v2`. `/api/synthesize` remains available. Newly saved local Omni profiles require voice setup again after this switch because their handles are not ElevenLabs voice IDs; existing real ElevenLabs voices remain usable. There is no automatic provider fallback during a request.

## Backup clips

First complete voice setup in the local app so `.voice-profiles/` contains the raw sample and transcript. Then run:

```powershell
node generate-backup.js "Your exact script text" interview
```

The mode is optional and defaults to `interview`. If more than one saved local profile exists, set `BACKUP_VOICE_PROFILE_ID` in `.env` to choose one.

The script and mode produce a deterministic filename such as:

```text
backup-clips/thank-you-for-the-opportunity-interview-a1b2c3d4e5.wav
```

The command refuses to overwrite an existing matching file. When live Omni generation fails, the server reports only a backup whose script and mode hash match the request. The UI labels it as a pre-generated backup before loading it into the normal comparison flow.

## Faster repeat practice

The studio saves script drafts on this device. After generation, **Listen again** replays the current track without a provider request; **Create a new version** explicitly generates another take. Editing a script or delivery setting keeps the previous audio available with a notice until a matching track is generated. Inputs are held steady during generation, and the two progress stages show elapsed time without inventing a completion percentage.

Identical script-and-mode delivery plans reuse successful reference measurements for five minutes (up to 64 entries per server). Concurrent matching planning requests share one ElevenLabs reading and still receive independent, single-use plan IDs. Failed planning is not cached. This saves reference requests on manual retries; Omni generation remains one attempt per explicit generation request.

## Rehearsal feedback and interactive practice

The score is now **Modulation match**: relative pitch movement, with initial
silence removed, median speaking pitch normalized, global timing adjustment
limited to 0.8–1.25, and monotonic local alignment limited to 240 ms. Smooth
Gaussian credit replaces the old all-or-nothing two-semitone score. Pacing and
speech/silence overlap are reported separately. Very short, poorly overlapping,
or substantially different-length takes receive no score. These acoustic checks
cannot verify that every word was read. Thresholds are engineering heuristics;
human listening calibration is still needed before claiming validated accuracy.

Reference words are visible by default and move with measured pitch. Tap a word
to replay from its timing. Recorded attempts have their own read-along. Where
alignment is absent, timings use that recording's voiced span and are explicitly
labeled estimated; individual words are not marked as errors using guessed timing.
An optional practice guide follows reference pace after speech starts, alongside
live pitch and microphone level. It is a timing guide, not speech recognition.
All of this analysis runs locally; it adds no provider calls. Reduced-motion
preferences disable moving words. The provider-generation pipeline is unchanged.

### Running tests

```powershell
npm test
node --check server.js
node --check public/js/app.js
node --check public/js/tts.js
```

The automated suite uses provider fakes and does not spend credits. A real end-to-end run requires valid provider configuration, a newly captured raw voice sample with its transcript, and availability from the public OmniVoice Space.

## Reliability limits

The default `k2-fsa/OmniVoice` endpoint is a public Hugging Face Space. It may sleep, queue, exhaust its ZeroGPU allowance, disconnect, change its interface, or exceed the 40-second limit. EchoVoice makes one Omni attempt and does not retry. Add a server-side `HUGGINGFACE_TOKEN` for authenticated quota. A live failure stops the loading state and offers a matching pre-generated backup when one exists.

Private voice references are stored on the server's local filesystem. Hosts with ephemeral filesystems can lose them after a restart or redeploy, so users may need to repeat voice setup. Production hosting should attach persistent private storage before relying on profiles across deploys.

Delivery plans are intentionally short-lived and stored in the current server process. A multi-instance deployment must use sticky routing or move the ten-minute plan records to a shared store.
