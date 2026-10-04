import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

export function backupBaseName(script, mode) {
  const normalized = script.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const readable = (normalized || "voice-reference").slice(0, 48).replace(/-$/g, "");
  const hash = createHash("sha256").update(`${mode}\0${script.trim()}`).digest("hex").slice(0, 10);
  return `${readable}-${mode}-${hash}`;
}

function extensionForMime(mimeType) {
  if (mimeType === "audio/mpeg") return "mp3";
  if (mimeType === "audio/ogg") return "ogg";
  if (mimeType === "audio/flac") return "flac";
  if (mimeType === "audio/mp4") return "m4a";
  if (mimeType === "audio/webm") return "webm";
  return "wav";
}

export async function findBackupClip(directory, script, mode) {
  const base = backupBaseName(script, mode);
  for (const extension of ["wav", "mp3", "ogg", "flac", "m4a", "webm"]) {
    const filename = `${base}.${extension}`;
    try {
      const stats = await fs.stat(path.join(directory, filename));
      if (stats.isFile() && stats.size > 0) return { filename, url: `/backup-clips/${encodeURIComponent(filename)}` };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return null;
}

export async function saveBackupClip(directory, script, mode, audio, mimeType) {
  const filename = `${backupBaseName(script, mode)}.${extensionForMime(mimeType)}`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, filename), audio, { flag: "wx" });
  return { filename, path: path.join(directory, filename), url: `/backup-clips/${encodeURIComponent(filename)}` };
}
