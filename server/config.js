import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROVIDERS = new Set(["omni", "elevenlabs"]);
const MODES = new Set(["interview", "presentation", "storytelling", "admissions"]);

function integer(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

export function loadConfig(env = process.env) {
  const requestedProvider = String(env.IDEAL_VOICE_PROVIDER || "omni").toLowerCase();
  const requestedMode = String(env.DEFAULT_DELIVERY_MODE || "interview").toLowerCase();
  const issues = [];
  if (!PROVIDERS.has(requestedProvider)) issues.push("IDEAL_VOICE_PROVIDER must be omni or elevenlabs.");
  if (!MODES.has(requestedMode)) issues.push("DEFAULT_DELIVERY_MODE is not a supported delivery mode.");

  const config = {
    idealVoiceProvider: PROVIDERS.has(requestedProvider) ? requestedProvider : "omni",
    omniTimeoutMs: integer(env.OMNI_TIMEOUT_MS, 40_000, 1_000, 120_000),
    omniSpaceId: String(env.OMNI_SPACE_ID || "k2-fsa/OmniVoice").trim(),
    huggingFaceToken: String(env.HUGGINGFACE_TOKEN || "").trim(),
    tokenAdminKey: String(env.TOKEN_ADMIN_KEY || "").trim(),
    elevenLabsApiKey: String(env.ELEVENLABS_API_KEY || "").trim(),
    elevenLabsReferenceVoiceId: String(env.ELEVENLABS_REFERENCE_VOICE_ID || "").trim(),
    maxScriptLength: integer(env.MAX_SCRIPT_LENGTH, 3_000, 100, 40_000),
    defaultDeliveryMode: MODES.has(requestedMode) ? requestedMode : "interview",
    profileDirectory: path.join(ROOT, ".voice-profiles"),
    backupDirectory: path.join(ROOT, "backup-clips"),
  };
  if (!config.omniSpaceId) issues.push("OMNI_SPACE_ID cannot be empty.");
  if (config.huggingFaceToken && !/^hf_[A-Za-z0-9]+$/.test(config.huggingFaceToken)) {
    issues.push("HUGGINGFACE_TOKEN must be a Hugging Face access token beginning with hf_.");
  }
  if (config.idealVoiceProvider === "omni" && !config.elevenLabsReferenceVoiceId) {
    issues.push("ELEVENLABS_REFERENCE_VOICE_ID is required when IDEAL_VOICE_PROVIDER=omni.");
  }
  return { ...config, issues: Object.freeze(issues) };
}

export function reportConfigIssues(config, logger = console) {
  for (const issue of config.issues || []) logger.warn(`[Config] ${issue}`);
}
