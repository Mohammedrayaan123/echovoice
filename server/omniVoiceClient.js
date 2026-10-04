import { Client, handle_file } from "@gradio/client";
import { VoiceServiceError } from "./voiceService.js";

export class OmniVoiceError extends VoiceServiceError {
  constructor(message, code, status = 502) {
    super(message, code, status);
    this.name = "OmniVoiceError";
  }
}

function statusError(message) {
  const detail = String(message || "");
  if (/zerogpu quota|exceeded.*quota/i.test(detail)) {
    return new OmniVoiceError("Voice generation capacity is temporarily exhausted.", "OMNI_QUOTA_EXCEEDED", 429);
  }
  return new OmniVoiceError("Voice generation could not be completed.", "OMNI_FAILED", 502);
}

function outputUrl(file) {
  const value = typeof file === "string" ? file : file?.url || file?.path;
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function outputMime(response, url) {
  const type = response.headers.get("content-type")?.split(";")[0]?.trim();
  if (type?.startsWith("audio/")) return type;
  if (/\.mp3(?:$|\?)/i.test(url)) return "audio/mpeg";
  if (/\.ogg(?:$|\?)/i.test(url)) return "audio/ogg";
  return "audio/wav";
}

export function createOmniVoiceClient({
  spaceId = "k2-fsa/OmniVoice", timeoutMs = 40_000, fetchImpl = globalThis.fetch,
  token = "", clientApi = Client, handleFile = handle_file, logger = console,
} = {}) {
  let activeToken = token;
  return {
    setToken(nextToken) { activeToken = nextToken; },
    async generate({ script, referenceAudio, referenceMimeType, referenceTranscript, instruction, targetDuration, targetSpeed }) {
      logger.info?.("[OmniVoice] start");
      logger.info?.(`[OmniVoice] durationTarget=${Number.isFinite(targetDuration) ? targetDuration.toFixed(1) : "auto"}`);
      const started = Date.now();
      let job;
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          try { job?.cancel?.()?.catch?.(() => {}); } catch { /* Timeout still wins if cancellation itself fails. */ }
          logger.warn?.(`[OmniVoice] timeout after ${(timeoutMs / 1000).toFixed(1)}s`);
          reject(new OmniVoiceError("Voice generation is taking longer than expected.", "OMNI_TIMEOUT", 504));
        }, timeoutMs);
      });
      const run = async () => {
        try {
          const requestToken = activeToken;
          const options = { events: ["status", "data"], ...(requestToken ? { token: requestToken } : {}) };
          const client = await clientApi.connect(spaceId, options);
          if (controller.signal.aborted) throw new OmniVoiceError("Voice generation is taking longer than expected.", "OMNI_TIMEOUT", 504);
          const reference = new Blob([referenceAudio], { type: referenceMimeType || "application/octet-stream" });
          job = client.submit("/_clone_fn", {
            text: script,
            lang: "Auto",
            ref_aud: handleFile(reference),
            ref_text: referenceTranscript,
            instruct: instruction,
            ns: 32,
            gs: 2.0,
            dn: true,
            sp: targetSpeed,
            du: Number.isFinite(targetDuration) && targetDuration > 0 ? targetDuration : null,
            pp: true,
            po: true,
          });
          let finalData = null;
          for await (const message of job) {
            if (message.type === "status" && (message.stage === "error" || message.status === "error")) {
              logger.warn?.("[OmniVoice] provider rejected the queued job.");
              throw statusError(message.message || message.code);
            }
            if (message.type === "data") finalData = message.data;
          }
          const url = Array.isArray(finalData) ? outputUrl(finalData[0]) : null;
          const statusText = Array.isArray(finalData) ? finalData[1] : null;
          if (typeof statusText === "string" && /^error\b/i.test(statusText.trim())) {
            logger.warn?.("[OmniVoice] provider rejected the generation request.");
            throw new OmniVoiceError("Voice generation could not be completed.", "OMNI_FAILED", 502);
          }
          if (!url) {
            throw new OmniVoiceError("Voice generation returned an unusable result.", "OMNI_MALFORMED_OUTPUT", 502);
          }
          const response = await fetchImpl(url, { signal: controller.signal });
          if (!response.ok) throw new OmniVoiceError("The generated voice track could not be downloaded.", "OMNI_OUTPUT_UNAVAILABLE", 502);
          const audio = Buffer.from(await response.arrayBuffer());
          if (!audio.length || audio.length > 50 * 1024 * 1024) {
            throw new OmniVoiceError("Voice generation returned an unusable result.", "OMNI_MALFORMED_OUTPUT", 502);
          }
          logger.info?.(`[OmniVoice] success time=${((Date.now() - started) / 1000).toFixed(1)}s`);
          return { audio, mimeType: outputMime(response, url) };
        } catch (error) {
          if (error instanceof OmniVoiceError) throw error;
          if (controller.signal.aborted) throw new OmniVoiceError("Voice generation is taking longer than expected.", "OMNI_TIMEOUT", 504);
          logger.error?.(`[OmniVoice] failed: ${error?.name || "unknown"}`);
          throw new OmniVoiceError("Voice generation could not be completed.", "OMNI_FAILED", 502);
        }
      };
      try { return await Promise.race([run(), timeout]); }
      finally { clearTimeout(timer); }
    },
  };
}
