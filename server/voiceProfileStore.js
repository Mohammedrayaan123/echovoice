import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { audioExtension } from "./audioLogger.js";
import { VoiceServiceError } from "./voiceService.js";

const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME_BY_EXTENSION = Object.freeze({
  wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", webm: "audio/webm",
  ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac", mov: "video/quicktime",
});

export function createVoiceProfileStore({ directory } = {}) {
  if (!directory) throw new Error("Voice profile storage directory is required.");
  const root = path.resolve(directory);
  function profilePath(profileId) {
    if (!PROFILE_ID.test(profileId || "")) throw new VoiceServiceError("The saved voice reference is invalid.", "missing_voice_sample", 400);
    return path.join(root, profileId);
  }
  return {
    async save({ file, transcript, voiceId }) {
      if (!file?.buffer?.length) throw new VoiceServiceError("A raw voice sample is required.", "missing_voice_sample", 400);
      const profileId = randomUUID();
      const folder = profilePath(profileId);
      const originalExtension = file.originalname?.match(/\.(wav|mp3|m4a|mp4|webm|ogg|flac|aac|mov)$/i)?.[1]?.toLowerCase();
      const extension = originalExtension || audioExtension(file.mimetype);
      const mimetype = file.mimetype === "application/octet-stream" && originalExtension
        ? MIME_BY_EXTENSION[originalExtension]
        : file.mimetype || MIME_BY_EXTENSION[extension] || "application/octet-stream";
      const audioName = `reference.${extension}`;
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, audioName), file.buffer, { flag: "wx" });
      await fs.writeFile(path.join(folder, "profile.json"), JSON.stringify({
        profileId, voiceId, transcript: String(transcript || "").trim(), mimetype,
        audioName, createdAt: new Date().toISOString(),
      }, null, 2), { flag: "wx" });
      return profileId;
    },
    async get(profileId) {
      const folder = profilePath(profileId);
      try {
        const metadata = JSON.parse(await fs.readFile(path.join(folder, "profile.json"), "utf8"));
        if (metadata.profileId !== profileId || !/^[\w.-]+$/.test(metadata.audioName || "")) throw new Error("invalid metadata");
        const audio = await fs.readFile(path.join(folder, metadata.audioName));
        if (!audio.length) throw new Error("empty audio");
        return { ...metadata, audio };
      } catch (error) {
        if (error instanceof VoiceServiceError) throw error;
        throw new VoiceServiceError("Set up your voice again so EchoVoice can use the raw reference.", "missing_voice_sample", 400);
      }
    },
    async list() {
      let ids = [];
      try { ids = await fs.readdir(root); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const profiles = [];
      for (const id of ids.filter((value) => PROFILE_ID.test(value))) {
        try {
          const metadata = JSON.parse(await fs.readFile(path.join(profilePath(id), "profile.json"), "utf8"));
          if (metadata.profileId === id) profiles.push(metadata);
        } catch { /* Ignore incomplete profiles. */ }
      }
      return profiles.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };
}
