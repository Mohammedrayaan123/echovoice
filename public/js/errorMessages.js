// errorMessages.js — shared demo-day-safe error-to-message mapping. Used by
// both app.js (generate errors) and voiceCapture.js (clone-creation errors) so
// there's exactly one place deciding what's safe to show — never raw API text.
export const ERROR_MESSAGES = {
  voice_not_found: "This voice is no longer available. Set up your voice again to continue.",
  rate_limited: "The voice service is busy. Wait a moment, then try again.",
  server_error: "The voice service is having trouble. Your script is safe — try again shortly.",
  auth_error: "The voice service could not connect. Please ask the app owner to check its connection.",
  not_configured: "Voice generation is not connected yet. Please ask the app owner to finish setup.",
  timeout: "The voice service took too long. The request may still finish; wait a moment before trying again.",
  network_error: "Could not reach the EchoVoice server. Check that the app is running and reload the page.",
  provider_network_error: "EchoVoice is running, but it could not reach ElevenLabs. Check the server's internet connection, then try again.",
  voice_limit_reached: "The voice library is full. Ask the app owner to remove an unused voice, then try again.",
  quota_exceeded: "The app has used its voice generation allowance. Please ask the app owner to check the plan.",
  verification_required: "This voice needs verification in ElevenLabs before it can be used. Ask the app owner to help complete it.",
  invalid_audio: "That recording could not be read. Try another audio file or record a new sample.",
  payload_too_large: "That audio file is too large. Choose a file under 10 MB for voice setup.",
  text_too_long: "That script is too long for this voice model. Try a shorter section.",
  no_text: "Type a script first.",
  no_voice: "Set up your voice first.",
  bad_request: "Check your script and voice settings, then try again.",
  clone_request_rejected: "Voice setup was rejected. Try a WAV or MP3 recording. If it continues, ask the app owner to check the voice account.",
  invalid_mode: "Choose a delivery mode and try again.",
  plan_required: "Plan your delivery again, then generate your reference.",
  plan_expired: "Your delivery plan expired. Generate it again.",
  missing_voice_sample: "Set up your voice again so EchoVoice can use the original recording.",
  missing_reference_transcript: "Set up your voice again and include the words spoken in the original recording.",
  reference_generation_failed: "EchoVoice could not plan this delivery. Try again shortly.",
  reference_audio_invalid: "EchoVoice could not measure the planning reference. Try again shortly.",
  OMNI_TIMEOUT: "Voice generation is taking longer than expected. Try again, or use a backup clip.",
  OMNI_FAILED: "Voice generation could not be completed. Try again, or use a backup clip.",
  OMNI_QUOTA_EXCEEDED: "Voice generation capacity is temporarily exhausted. Try again later, or use a backup clip.",
  OMNI_MALFORMED_OUTPUT: "Voice generation returned an unusable track. Try again, or use a backup clip.",
  OMNI_OUTPUT_UNAVAILABLE: "The generated track could not be loaded. Try again, or use a backup clip.",
  unknown: "Something went wrong. Please try again.",
};

export function friendlyErrorMessage(err) {
  const code = err && ERROR_MESSAGES[err.code] ? err.code : "unknown";
  return ERROR_MESSAGES[code];
}
