// audioLog.js — fire-and-forget upload of a copy of every audio blob that
// passes through the app (recordings and TTS output) to the server's
// /save-audio endpoint. Purely a remote-debugging side channel — the server
// proxies it to Supabase Storage (and saves a local copy in dev) so audio
// produced on someone else's machine (e.g. testing against the hosted
// deployment) is still reachable. Never awaited by callers, and never
// throws: a failure here must never affect recording or playback.

/**
 * @param {Blob} blob
 * @param {"recording"|"guided"|"tts-generated"|"user-attempt"} type
 */
export function logAudio(blob, type) {
  const formData = new FormData();
  formData.append("audio", blob, "audio"); // server derives the real filename/extension
  formData.append("type", type);
  fetch("/save-audio", { method: "POST", body: formData }).catch(() => {
    // Best-effort — the server already logs its own failures server-side.
  });
}
