import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

export const AUDIO_LOG_TYPES = new Set([
  "recording", "guided", "tts-generated", "user-attempt", "reference-reading", "ideal-omni",
]);

export function audioExtension(mimetype = "") {
  const type = mimetype.toLowerCase();
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
  if (type.includes("mp4")) return "mp4";
  if (type.includes("wav")) return "wav";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("flac")) return "flac";
  return "webm";
}

export function createAudioLogger({ supabaseClient, logger = console, saveLocalAudio = false, rootDirectory = process.cwd() } = {}) {
  return {
    async log(buffer, requestedType, mimetype = "application/octet-stream") {
      if (!buffer?.length) return null;
      const type = AUDIO_LOG_TYPES.has(requestedType) ? requestedType : "unknown";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${stamp}_${type}_${randomUUID()}.${audioExtension(mimetype)}`;
      let url = null;
      if (supabaseClient) {
        try {
          const { error } = await supabaseClient.storage.from("audio-logs").upload(filename, buffer, {
            contentType: mimetype, upsert: false,
          });
          if (error) throw error;
          url = supabaseClient.storage.from("audio-logs").getPublicUrl(filename).data.publicUrl;
        } catch {
          logger.warn("Audio log: optional remote save failed.");
        }
      }
      if (saveLocalAudio) {
        try {
          const directory = path.join(rootDirectory, "audio-logs");
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(path.join(directory, filename), buffer);
        } catch {
          logger.warn("Audio log: optional local save failed.");
        }
      }
      return url;
    },
  };
}

