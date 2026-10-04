import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import supabase from "./supabaseClient.js";
import { loadConfig } from "./server/config.js";
import { createAudioLogger } from "./server/audioLogger.js";
import { createVoiceService } from "./server/voiceService.js";
import { createElevenLabsClient } from "./server/elevenLabsClient.js";
import { createDeliveryPlanner } from "./server/deliveryPlanner.js";
import { createOmniVoiceClient } from "./server/omniVoiceClient.js";
import { createVoiceProfileStore } from "./server/voiceProfileStore.js";
import { createIdealGenerationService } from "./server/idealGenerationService.js";
import { findBackupClip, saveBackupClip } from "./server/backupClips.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const script = process.argv[2]?.trim();
const mode = (process.argv[3] || "interview").toLowerCase();

if (!script) {
  console.error('Usage: node generate-backup.js "<script text>" [interview|presentation|storytelling|admissions]');
  process.exitCode = 1;
} else {
  try {
    const baseConfig = loadConfig();
    const config = { ...baseConfig, idealVoiceProvider: "omni" };
    const profileStore = createVoiceProfileStore({ directory: config.profileDirectory });
    const profiles = await profileStore.list();
    const requestedProfile = process.env.BACKUP_VOICE_PROFILE_ID?.trim();
    const profile = requestedProfile ? profiles.find((item) => item.profileId === requestedProfile) : profiles.length === 1 ? profiles[0] : null;
    if (!profile) {
      throw new Error(profiles.length
        ? "Set BACKUP_VOICE_PROFILE_ID to the voice profile to use because more than one saved profile exists."
        : "Set up a voice in EchoVoice before generating a backup clip.");
    }
    const existing = await findBackupClip(config.backupDirectory, script, mode);
    if (existing) throw Object.assign(new Error(`Matching backup already exists: ${existing.filename}`), { code: "EEXIST" });

    const audioLogger = createAudioLogger({
      supabaseClient: supabase, logger: console, saveLocalAudio: process.env.NODE_ENV !== "production", rootDirectory: root,
    });
    const voiceService = createVoiceService({ apiKey: config.elevenLabsApiKey });
    const deliveryPlanner = createDeliveryPlanner({
      elevenLabsClient: createElevenLabsClient({
        apiKey: config.elevenLabsApiKey, referenceVoiceId: config.elevenLabsReferenceVoiceId,
      }),
      audioLogger, logger: console, maxScriptLength: config.maxScriptLength, defaultMode: config.defaultDeliveryMode,
    });
    const service = createIdealGenerationService({
      config,
      voiceService,
      deliveryPlanner,
      omniVoiceClient: createOmniVoiceClient({ spaceId: config.omniSpaceId, timeoutMs: config.omniTimeoutMs, logger: console }),
      voiceProfileStore: profileStore,
      audioLogger,
      logger: console,
    });
    const plan = await service.plan({ script, mode });
    const result = await service.generate({
      plannerId: plan.plannerId, script, mode, voiceId: profile.voiceId, voiceProfileId: profile.profileId,
    });
    const saved = await saveBackupClip(config.backupDirectory, script, mode, Buffer.from(result.audioBase64, "base64"), result.mimeType);
    console.log(`Backup clip created: ${saved.path}`);
  } catch (error) {
    console.error(error.code === "EEXIST" ? error.message : `Backup generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

