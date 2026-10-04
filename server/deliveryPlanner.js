import { VoiceServiceError } from "./voiceService.js";

export const MODE_PROFILES = Object.freeze({
  interview: Object.freeze({
    label: "Interview",
    description: "Calm, confident, and conversational.",
    style: "Speak calmly and confidently in a conversational interview style",
    pauses: "Use brief natural pauses after major ideas",
    emphasis: "Add moderate emphasis to key points",
  }),
  presentation: Object.freeze({
    label: "Presentation",
    description: "Clear, deliberate, and authoritative.",
    style: "Speak clearly with a projected, deliberate, and authoritative presentation style",
    pauses: "Use purposeful pauses between major ideas",
    emphasis: "Add strong but controlled emphasis to important points",
  }),
  storytelling: Object.freeze({
    label: "Storytelling",
    description: "Expressive, engaging, and dynamic.",
    style: "Speak with an expressive, engaging, and dynamic storytelling style",
    pauses: "Use natural dramatic pauses where appropriate",
    emphasis: "Vary emphasis and energy to keep the listener engaged",
  }),
  admissions: Object.freeze({
    label: "Admissions",
    description: "Warm, thoughtful, sincere, and confident.",
    style: "Speak warmly, thoughtfully, sincerely, and confidently in an admissions setting",
    pauses: "Use short reflective pauses between important ideas",
    emphasis: "Add subtle emphasis to personal strengths and meaningful points",
  }),
});

export const SPEED_MAPPING = Object.freeze({ baselineWpm: 135, minimum: 0.85, maximum: 1.15 });

export function validateDeliveryInput({ script, mode }, { maxScriptLength = 5_000, defaultMode = "interview" } = {}) {
  if (typeof script !== "string" || !script.trim()) throw new VoiceServiceError("Script text is required.", "no_text", 400);
  const cleanScript = script.trim();
  if (cleanScript.length > maxScriptLength) throw new VoiceServiceError(`Scripts are limited to ${maxScriptLength} characters.`, "text_too_long", 400);
  const resolvedMode = mode == null || mode === "" ? defaultMode : String(mode).toLowerCase();
  if (!Object.hasOwn(MODE_PROFILES, resolvedMode)) throw new VoiceServiceError("Choose a valid delivery mode.", "invalid_mode", 400);
  return { script: cleanScript, mode: resolvedMode, profile: MODE_PROFILES[resolvedMode] };
}

export function buildInstruction(profile, targetDuration) {
  return `${profile.style}. ${profile.pauses}. ${profile.emphasis}. Target approximately ${targetDuration.toFixed(1)} seconds overall.`;
}

export function calculateTargetSpeed(measuredWpm) {
  const raw = measuredWpm / SPEED_MAPPING.baselineWpm;
  return Number(Math.max(SPEED_MAPPING.minimum, Math.min(SPEED_MAPPING.maximum, raw)).toFixed(2));
}

export function createDeliveryPlanner({ elevenLabsClient, audioLogger, logger = console, maxScriptLength = 5_000, defaultMode = "interview" } = {}) {
  return {
    async plan(input) {
      const { script, mode, profile } = validateDeliveryInput(input, { maxScriptLength, defaultMode });
      logger.info?.(`[DeliveryPlanner] mode=${mode}`);
      const reference = await elevenLabsClient.generateReference(script);
      await audioLogger?.log(reference.audio, "reference-reading", reference.mimeType);
      const wordCount = script.split(/\s+/u).filter(Boolean).length;
      const targetDuration = Number(reference.durationSeconds.toFixed(1));
      const measuredWpm = Math.round(wordCount / (reference.durationSeconds / 60));
      const targetSpeed = calculateTargetSpeed(measuredWpm);
      const instruction = buildInstruction(profile, targetDuration);
      logger.info?.(`[DeliveryPlanner] duration=${targetDuration.toFixed(1)}s`);
      logger.info?.(`[DeliveryPlanner] wpm=${measuredWpm}`);
      logger.info?.(`[DeliveryPlanner] targetSpeed=${targetSpeed.toFixed(2)}`);
      // OmniVoice currently accepts only speaker attributes (for example,
      // "moderate pitch") in `instruct`. Delivery prose such as pause or
      // emphasis guidance is rejected by the public Space, so keep the full
      // plan for EchoVoice and omit voice-design attributes during cloning.
      // A hard provider duration can force speech tokens into too little time
      // and corrupt words. Keep the measured duration in EchoVoice's plan,
      // but let OmniVoice estimate enough output length and guide pace with
      // its bounded speed control instead.
      return {
        script, mode, instruction, providerInstruction: "", providerTargetDuration: null,
        targetDuration, targetSpeed, measuredWpm, wordCount,
      };
    },
  };
}
