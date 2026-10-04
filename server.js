// Serve public/ and keep all provider credentials on the server.
import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import supabase from "./supabaseClient.js";
import { createVoiceService, VoiceServiceError, MAX_AUDIO_FILE_BYTES } from "./server/voiceService.js";
import { loadConfig, reportConfigIssues } from "./server/config.js";
import { createAudioLogger } from "./server/audioLogger.js";
import { createElevenLabsClient } from "./server/elevenLabsClient.js";
import { createDeliveryPlanner, MODE_PROFILES } from "./server/deliveryPlanner.js";
import { createOmniVoiceClient } from "./server/omniVoiceClient.js";
import { createVoiceProfileStore } from "./server/voiceProfileStore.js";
import { createIdealGenerationService } from "./server/idealGenerationService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Inject dependencies to test real HTTP routes without paid provider requests,
// account mutations, or writing recordings to disk.
export function createApp({
  apiKey = process.env.ELEVENLABS_API_KEY,
  fetchImpl = globalThis.fetch,
  supabaseClient = supabase,
  logger = console,
  saveLocalAudio = process.env.NODE_ENV !== "production",
  cloneTimeoutMs,
  speechTimeoutMs,
  runtimeConfig,
  profileStore,
  audioLogger,
  idealGenerationService,
  omniVoiceClient,
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  const config = runtimeConfig || loadConfig({ ...process.env, ELEVENLABS_API_KEY: apiKey || process.env.ELEVENLABS_API_KEY });
  const service = createVoiceService({ apiKey, fetchImpl, cloneTimeoutMs, speechTimeoutMs, logger });
  const logService = audioLogger || createAudioLogger({ supabaseClient, logger, saveLocalAudio, rootDirectory: __dirname });
  const storedProfiles = profileStore || createVoiceProfileStore({ directory: config.profileDirectory });
  const referenceClient = createElevenLabsClient({
    apiKey, referenceVoiceId: config.elevenLabsReferenceVoiceId, fetchImpl, timeoutMs: speechTimeoutMs,
  });
  const planner = createDeliveryPlanner({
    elevenLabsClient: referenceClient, audioLogger: logService, logger,
    maxScriptLength: config.maxScriptLength, defaultMode: config.defaultDeliveryMode,
  });
  const omniClient = omniVoiceClient || createOmniVoiceClient({
    spaceId: config.omniSpaceId, token: config.huggingFaceToken,
    timeoutMs: config.omniTimeoutMs, fetchImpl, logger,
  });
  const generation = idealGenerationService || createIdealGenerationService({
    config, voiceService: service, deliveryPlanner: planner, omniVoiceClient: omniClient,
    voiceProfileStore: storedProfiles, audioLogger: logService, logger,
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_FILE_BYTES, files: 4, fields: 8, fieldSize: Math.max(4096, config.maxScriptLength * 2), parts: 14 },
    fileFilter(req, file, done) {
      const type = (file.mimetype || "").toLowerCase();
      // Browser-recorded audio may use a video container (notably Safari).
      if (/^audio\//.test(type) || ["video/webm", "video/mp4", "video/quicktime"].includes(type)) return done(null, true);
      if (type === "application/octet-stream" && /\.(wav|mp3|m4a|mp4|webm|ogg|flac|aac|mov)$/i.test(file.originalname)) return done(null, true);
      done(new VoiceServiceError("Choose an audio recording.", "invalid_audio", 400));
    },
  });

  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(express.json({ limit: "256kb" }));
  app.use("/backup-clips", express.static(config.backupDirectory, { index: false, etag: true, fallthrough: true }));
  app.use(express.static(path.join(__dirname, "public"), { etag: false, lastModified: false, cacheControl: false }));
  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.get("/api/studio-config", (req, res) => res.json({
    defaultDeliveryMode: config.defaultDeliveryMode,
    maxScriptLength: config.maxScriptLength,
    voiceModelControlsEnabled: config.idealVoiceProvider === "elevenlabs",
    tokenUpdateEnabled: Boolean(config.tokenAdminKey),
    deliveryModes: Object.entries(MODE_PROFILES).map(([id, profile]) => ({ id, label: profile.label, description: profile.description })),
  }));

  app.post("/api/admin/huggingface-token", (req, res) => {
    const suppliedKey = typeof req.body?.adminKey === "string" ? req.body.adminKey : "";
    const expectedKey = config.tokenAdminKey;
    const suppliedBuffer = Buffer.from(suppliedKey);
    const expectedBuffer = Buffer.from(expectedKey);
    const authorized = Boolean(expectedKey)
      && suppliedBuffer.length === expectedBuffer.length
      && timingSafeEqual(suppliedBuffer, expectedBuffer);
    if (!authorized) {
      return res.status(403).json({ success: false, error: "The admin key is incorrect.", errorCode: "admin_forbidden" });
    }
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!/^hf_[A-Za-z0-9]+$/.test(token)) {
      return res.status(400).json({ success: false, error: "Enter a valid Hugging Face token.", errorCode: "invalid_token" });
    }
    omniClient.setToken(token);
    logger.info?.("[Config] Hugging Face token updated for this server session.");
    return res.json({ success: true });
  });

  // Preserve the raw reference for Omni. Only the ElevenLabs switchback needs
  // a provider clone; never delete previously selected account voices.
  app.post("/api/clone-voice", upload.array("audio", 4), async (req, res, next) => {
    try {
      if (!req.files?.length || req.files.some((file) => !file.size)) {
        throw new VoiceServiceError("Record or upload an audio sample first.", "invalid_audio", 400);
      }
      const transcript = typeof req.body?.transcript === "string" ? req.body.transcript.trim() : "";
      if (transcript.length > config.maxScriptLength) {
        throw new VoiceServiceError(`Reference transcripts are limited to ${config.maxScriptLength} characters.`, "text_too_long", 400);
      }
      if (config.idealVoiceProvider === "omni") {
        if (req.files.length !== 1) {
          throw new VoiceServiceError("Choose one raw reference recording with its exact transcript.", "invalid_audio", 400);
        }
        if (!transcript) {
          throw new VoiceServiceError("Include the exact words spoken in your recording.", "missing_reference_transcript", 400);
        }
        // Keep the existing frontend voice/profile contract without pretending
        // this local handle is an ElevenLabs voice ID.
        const voiceId = `local_${randomUUID()}`;
        const voiceProfileId = await storedProfiles.save({ file: req.files[0], transcript, voiceId });
        return res.json({ voiceId, voiceProfileId, requiresVerification: false });
      }
      const result = await service.clone(req.files, req.body?.name);
      const voiceProfileId = transcript
        ? await storedProfiles.save({ file: req.files[0], transcript, voiceId: result.voiceId })
        : null;
      res.json(voiceProfileId ? { ...result, voiceProfileId } : result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/synthesize", async (req, res, next) => {
    try {
      res.json(await service.synthesize(req.body));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/preview-voice", async (req, res, next) => {
    try {
      res.json(await generation.preview(req.body));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/plan-delivery", async (req, res, next) => {
    try {
      res.json(await generation.plan(req.body));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/generate-ideal", async (req, res, next) => {
    try {
      res.json(await generation.generate(req.body));
    } catch (error) {
      next(error);
    }
  });

  // Optional diagnostic audio storage stays best-effort. Unique names avoid
  // collisions when several friends test the app in the same second.
  app.post("/save-audio", upload.single("audio"), async (req, res) => {
    if (!req.file?.size) return res.status(400).json({ ok: false, error: "No audio file received." });
    const url = await logService.log(req.file.buffer, req.body.type, req.file.mimetype);
    res.json({ ok: true, url });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof VoiceServiceError) {
      logger.warn(`Voice request failed: route=${req.path} code=${error.code}`);
      return res.status(error.status).json({
        success: false, error: error.message, errorCode: error.code, code: error.code,
        ...(error.details || {}),
      });
    }
    if (error instanceof multer.MulterError) {
      const tooLarge = ["LIMIT_FILE_SIZE", "LIMIT_PART_COUNT", "LIMIT_FILE_COUNT"].includes(error.code);
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? "Use up to four recordings, each smaller than 25 MB." : "Invalid audio upload.",
        errorCode: tooLarge ? "payload_too_large" : "bad_request",
      });
    }
    if (error.type === "entity.too.large") {
      return res.status(413).json({ error: "This request is too large.", errorCode: "payload_too_large" });
    }
    if (error.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Invalid JSON request.", errorCode: "bad_request" });
    }
    logger.error("Unexpected request failure.");
    res.status(500).json({ error: "The request could not be completed.", errorCode: "server_error" });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 5500;
  const runtimeConfig = loadConfig();
  reportConfigIssues(runtimeConfig);
  createApp({ runtimeConfig }).listen(port, () => {
    console.log(`EchoVoice running on port ${port}`);
    if (!process.env.ELEVENLABS_API_KEY) console.warn("ELEVENLABS_API_KEY is missing; cloning and generation are unavailable.");
    if (!supabase) console.warn("Optional remote audio logging is not configured.");
  });
}
