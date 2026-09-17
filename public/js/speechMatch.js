// speechMatch.js — verification-sentence pool + fuzzy text matching, and a thin
// wrapper around the browser's Web Speech API (SpeechRecognition).
//
// SpeechRecognition is NOT universally supported (Chrome/Edge: yes; Firefox/Safari:
// no or partial). Per the product intent here ("a UX flow, not a security feature"),
// an unsupported browser should never be able to block verification — callers
// should treat isSupported === false as "skip this check, don't fail it."

export const VERIFICATION_SENTENCES = [
  "In the sky of life, freedom is the brightest star.",
  "Cars drive us to new places, books drive our imaginations farther.",
  "The mountains whisper secrets to those who listen with wonder.",
  "Every sunrise brings a chance to start again, quietly and surely.",
  "The old library held stories that time itself forgot to erase.",
];

let lastIndex = -1;

// Rotates through the pool without repeating the immediately-previous sentence
// (each of the up-to-3 verification attempts gets a different one).
export function pickSentence() {
  let idx;
  do {
    idx = Math.floor(Math.random() * VERIFICATION_SENTENCES.length);
  } while (idx === lastIndex && VERIFICATION_SENTENCES.length > 1);
  lastIndex = idx;
  return VERIFICATION_SENTENCES[idx];
}

function normalizeToWords(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, "") // strip punctuation, keep letters/numbers/apostrophes
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Fraction (0-1) of the target sentence's words that also appear in the
 * transcript, ignoring case/punctuation/word order. Deliberately lenient —
 * this is the "80%+ word overlap counts as a match" rule, not exact comparison.
 */
export function wordOverlapRatio(transcript, target) {
  const targetWords = normalizeToWords(target);
  if (targetWords.length === 0) return 0;
  const transcriptWords = new Set(normalizeToWords(transcript));
  const matched = targetWords.filter((w) => transcriptWords.has(w)).length;
  return matched / targetWords.length;
}

const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
export const isSpeechRecognitionSupported = Boolean(SpeechRecognitionClass);

/**
 * Listens on the mic for up to maxDurationMs. Returns a handle (not a bare
 * Promise) because callers need to be able to cancel a still-running attempt
 * (e.g. the user clicks "Skip Verification" mid-recording) — without this,
 * SpeechRecognition keeps the mic active in the background for the rest of
 * its window even after the UI has moved on.
 * @param {number} maxDurationMs
 * @param {string} [lang] - BCP-47 tag for recognition (e.g. "en-US", "ar-SA");
 *   defaults to English.
 * @returns {{promise: Promise<string|null>, cancel: () => void, stop: () => void}}
 *   promise resolves with the transcript (empty string if nothing recognized),
 *   or null if the API isn't supported/couldn't start, OR if cancel() was used
 *   — callers should treat null as "skip this check," never as a failure.
 *   Never rejects. cancel() aborts immediately, discarding any transcript so
 *   far (for abandoning the attempt entirely). stop() ends recognition
 *   gracefully — same effect as the maxDurationMs timeout firing early — so
 *   the promise still resolves with whatever was already recognized (for a
 *   user-initiated early stop, where they likely already finished speaking).
 */
export function transcribeLive(maxDurationMs, lang = "en-US") {
  if (!SpeechRecognitionClass) {
    return { promise: Promise.resolve(null), cancel: () => {}, stop: () => {} };
  }

  const recognition = new SpeechRecognitionClass();
  recognition.lang = lang;
  recognition.continuous = true;
  recognition.interimResults = false;

  let finalTranscript = "";
  let settled = false;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(stopTimer);
    try {
      recognition.stop();
    } catch {
      // Already stopped — fine.
    }
    resolvePromise(finalTranscript.trim());
  };

  const cancel = () => {
    if (settled) return;
    settled = true;
    clearTimeout(stopTimer);
    try {
      recognition.abort();
    } catch {
      // Already stopped — fine.
    }
    resolvePromise(null);
  };

  recognition.addEventListener("result", (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        finalTranscript += " " + event.results[i][0].transcript;
      }
    }
  });
  recognition.addEventListener("end", finish);
  recognition.addEventListener("error", finish); // e.g. "no-speech" — resolve with whatever we have, don't reject

  const stopTimer = setTimeout(finish, maxDurationMs);

  // Ends recognition the same graceful way the maxDurationMs timeout does —
  // finish() (already wired to the "end" event) resolves with whatever was
  // recognized up to this point, instead of discarding it like cancel() does.
  const stop = () => {
    if (settled) return;
    try {
      recognition.stop();
    } catch {
      // Already stopped — fine.
    }
  };

  try {
    recognition.start();
  } catch {
    settled = true;
    clearTimeout(stopTimer);
    resolvePromise(null); // couldn't start at all (e.g. permission race) — treat as unsupported, not a failure
  }

  return { promise, cancel, stop };
}
