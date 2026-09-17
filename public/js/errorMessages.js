// errorMessages.js — shared demo-day-safe error-to-message mapping. Used by
// both app.js (generate errors) and voiceCapture.js (clone-creation errors) so
// there's exactly one place deciding what's safe to show — never raw API text.
export const ERROR_MESSAGES = {
  voice_not_found: "Your voice profile has expired — please set up your voice again.",
  rate_limited: "Too many requests right now. Wait a moment and try again, or use a backup clip.",
  server_error: "The voice service is having issues. Try again in a moment, or use a backup clip.",
  auth_error: "Voice generation isn't available right now. Try a backup clip.",
  not_configured: "Voice generation isn't set up yet. Try a backup clip.",
  timeout: "That took too long. Check your connection and try again, or use a backup clip.",
  network_error: "Couldn't reach the server. Check your connection and try again, or use a backup clip.",
  no_text: "Type a script first.",
  no_voice: "Set up your voice or paste a voice ID first.",
  bad_request: "Something wasn't right with that request. Try again, or use a backup clip.",
  unknown: "Something went wrong. Try again, or use a backup clip.",
};

export function friendlyErrorMessage(err) {
  const code = err && ERROR_MESSAGES[err.code] ? err.code : "unknown";
  return ERROR_MESSAGES[code];
}
