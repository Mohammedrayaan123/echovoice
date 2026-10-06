# EchoVoice Studio design

The main product follows the uploaded waitlist page's midnight canvas, warm off-white type, lime accent, hairline borders, and quiet editorial spacing. The supplied `echovoice-logo-v2.png` appears in the navigation, loading state, and browser icon.

## Journey

1. **Your voice:** capture or upload 7–10 seconds of natural speech. The review step checks duration and basic signal health, asks for the exact spoken transcript, and collects cloning permission. Omni setup privately saves the raw reference; the listener compares their original with a neutral preview before selecting it.
2. **Your words:** write a script, choose a starting point, and select Interview, Presentation, Storytelling, or Admissions delivery.
3. **Your delivery:** EchoVoice plans broad pace and style from a short reference performance, then generates the final ideal track in the user's voice. The user records a take and inspects timing and pitch. The score is explicitly a pitch comparison, not a measure of voice identity.

## Visual language

Generation shows two explicit stages and elapsed time with the existing breathing waveform. A finished track offers **Listen again**; creating another version is a separate action that mentions generation allowance. Edited words keep the previous track available with a clear mismatch notice. Draft status and a keyboard shortcut sit below the script, and the read-along is analyzed when opened.

- Background `#08090a`; surfaces `#0f1112` and `#17191b`.
- Primary text `#f5f6f2`; accent `#e4f222`; restrained teal for the user's waveform.
- Inter for interface text; JetBrains Mono for small numbers and labels.
- Motion is brief and purposeful: entry, progress, recording pulse, waveform, and score reveal. Reduced motion disables ornamental animation.
- Cards and the modal share the same border, corner, and spacing rhythm. Mobile uses a single column and full-width actions.

## Accuracy choices

The app asks for a clean, single-speaker recording lasting 7–10 seconds with its exact transcript. It requests microphone automatic gain for normal handheld distance, keeps browser noise reduction disabled, and balances quiet captures with a bounded constant gain before playback and cloning. Pitch and timing are preserved; uploaded audio is unchanged. Listeners compare their source with a neutral preview. Omni setup does not create an ElevenLabs clone. The preview generates directly in Omni without a paid planner call, using one attempt and the standard timeout; the ElevenLabs mode retains a Multilingual v2 preview. A user can keep their current profile when trying a replacement. Real likeness still needs listening tests with actual speakers and recordings.

The production generation layer uses an ElevenLabs stock-voice reading only to measure approximate duration and pace. OmniVoice independently generates the final ideal track from the raw sample and its reviewed transcript. The ElevenLabs reading does not transfer exact prosody. The public OmniVoice Space remains a demo-grade dependency, so generation has one hard timeout and an explicit pre-generated backup path.
