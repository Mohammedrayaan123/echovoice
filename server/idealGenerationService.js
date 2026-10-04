import { createHash, randomUUID } from "node:crypto";
import { VoiceServiceError } from "./voiceService.js";
import { validateDeliveryInput } from "./deliveryPlanner.js";
import { findBackupClip } from "./backupClips.js";

const PLAN_TTL_MS = 10 * 60_000;
const PLAN_ID = /^[0-9a-f-]{36}$/i;
const REFERENCE_CACHE_MS = 5 * 60_000;
const REFERENCE_CACHE_LIMIT = 64;

function fingerprint(script) {
  return createHash("sha256").update(script).digest("hex");
}

export function createIdealGenerationService({
  config, voiceService, deliveryPlanner, omniVoiceClient, voiceProfileStore, audioLogger, logger = console,
} = {}) {
  const plans = new Map();
  // Only stock-reading plan metadata is reused; no cloned audio or raw voice.
  const referencePlans = new Map();
  async function referencePlan(input) {
    const key = fingerprint(JSON.stringify([input.script, input.mode]));
    for (const [id, entry] of referencePlans) {
      if (entry.expiresAt <= Date.now()) referencePlans.delete(id);
    }
    if (referencePlans.has(key)) return referencePlans.get(key).promise;
    while (referencePlans.size >= REFERENCE_CACHE_LIMIT) referencePlans.delete(referencePlans.keys().next().value);
    const entry = { expiresAt: Date.now() + REFERENCE_CACHE_MS };
    entry.promise = Promise.resolve().then(() => deliveryPlanner.plan(input)).then(result => {
      entry.expiresAt = Date.now() + REFERENCE_CACHE_MS;
      const { script, mode, instruction, providerInstruction, providerTargetDuration, targetDuration, targetSpeed, measuredWpm, wordCount } = result;
      return { script, mode, instruction, providerInstruction, providerTargetDuration, targetDuration, targetSpeed, measuredWpm, wordCount };
    }).catch(error => {
      if (referencePlans.get(key) === entry) referencePlans.delete(key);
      throw error;
    });
    referencePlans.set(key, entry);
    return entry.promise;
  }
  function cleanPlans() {
    const now = Date.now();
    for (const [id, plan] of plans) if (plan.expiresAt <= now) plans.delete(id);
  }
  async function loadReference(input) {
    if (typeof input?.voiceProfileId !== "string" || !input.voiceProfileId) {
      throw new VoiceServiceError("Set up your voice again so EchoVoice can use the raw reference.", "missing_voice_sample", 400);
    }
    const profile = await voiceProfileStore.get(input.voiceProfileId);
    if (profile.voiceId && profile.voiceId !== input.voiceId) {
      throw new VoiceServiceError("The saved voice reference does not match this voice.", "missing_voice_sample", 400);
    }
    if (!profile.transcript?.trim()) {
      throw new VoiceServiceError("Add the transcript of your raw voice sample during voice setup.", "missing_reference_transcript", 400);
    }
    return profile;
  }
  return {
    async preview(input) {
      if (config.idealVoiceProvider === "elevenlabs") {
        const result = await voiceService.synthesize({ ...input, modelId: "eleven_multilingual_v2" });
        await audioLogger?.log(Buffer.from(result.audioBase64, "base64"), "tts-generated", result.mimeType);
        return result;
      }
      const { script } = validateDeliveryInput({ script: input?.text }, config);
      const profile = await loadReference(input);
      try {
        // A neutral audition needs no stock-voice planning request. The same
        // raw reference and timed, single-attempt Omni client generate it.
        const result = await omniVoiceClient.generate({
          script, referenceAudio: profile.audio, referenceMimeType: profile.mimetype,
          referenceTranscript: profile.transcript, instruction: "", targetDuration: null, targetSpeed: 1,
        });
        await audioLogger?.log(result.audio, "tts-generated", result.mimeType);
        return { success: true, audioBase64: result.audio.toString("base64"), mimeType: result.mimeType, alignment: null };
      } catch (error) {
        if (error instanceof VoiceServiceError) throw error;
        logger.error?.("[OmniVoice] unexpected preview failure.");
        throw new VoiceServiceError("Voice generation could not be completed.", "OMNI_FAILED", 502);
      }
    },
    async plan(input) {
      cleanPlans();
      const validated = validateDeliveryInput(input, config);
      const planned = config.idealVoiceProvider === "omni"
        ? await referencePlan(validated)
        : { ...validated, instruction: null, targetDuration: null, targetSpeed: null, measuredWpm: null };
      const plannerId = randomUUID();
      plans.set(plannerId, { ...planned, scriptHash: fingerprint(validated.script), expiresAt: Date.now() + PLAN_TTL_MS });
      return {
        plannerId,
        instruction: planned.instruction,
        targetDuration: planned.targetDuration,
        targetSpeed: planned.targetSpeed,
        measuredWpm: planned.measuredWpm,
      };
    },
    async generate(input) {
      cleanPlans();
      const { script, mode } = validateDeliveryInput(input, config);
      if (!PLAN_ID.test(input?.plannerId || "")) throw new VoiceServiceError("Plan your delivery before generating it.", "plan_required", 400);
      const plan = plans.get(input.plannerId);
      plans.delete(input.plannerId);
      if (!plan || plan.expiresAt <= Date.now() || plan.mode !== mode || plan.scriptHash !== fingerprint(script)) {
        throw new VoiceServiceError("The delivery plan expired. Try generating again.", "plan_expired", 400);
      }
      if (config.idealVoiceProvider === "elevenlabs") {
        const result = await voiceService.synthesize({
          voiceId: input.voiceId, text: script, modelId: input.modelId,
          languageCode: input.languageCode, voiceSettings: input.voiceSettings,
        });
        await audioLogger?.log(Buffer.from(result.audioBase64, "base64"), "tts-generated", result.mimeType);
        return { success: true, ...result };
      }
      const profile = await loadReference(input);
      try {
        const result = await omniVoiceClient.generate({
          script,
          referenceAudio: profile.audio,
          referenceMimeType: profile.mimetype,
          referenceTranscript: profile.transcript,
          instruction: plan.providerInstruction,
          targetDuration: plan.providerTargetDuration,
          targetSpeed: plan.targetSpeed,
        });
        await audioLogger?.log(result.audio, "ideal-omni", result.mimeType);
        return {
          success: true,
          audioBase64: result.audio.toString("base64"),
          mimeType: result.mimeType,
          alignment: null,
        };
      } catch (error) {
        const backup = await findBackupClip(config.backupDirectory, script, mode);
        if (error instanceof VoiceServiceError) {
          error.details = { backupAvailable: Boolean(backup), backupUrl: backup?.url || null };
          throw error;
        }
        logger.error?.("[OmniVoice] unexpected generation failure.");
        const wrapped = new VoiceServiceError("Voice generation could not be completed.", "OMNI_FAILED", 502);
        wrapped.details = { backupAvailable: Boolean(backup), backupUrl: backup?.url || null };
        throw wrapped;
      }
    },
  };
}
