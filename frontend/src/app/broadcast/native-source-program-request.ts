import type { NativeSourceProgramRequest } from "./native-source-program-controller";
import { normalizeSourceAudioOutput } from "./native-source-audio-output";
import { normalizeSourceVideoOutput } from "./native-source-video-output";

/** Optional feature validation; no room, device or capture authority. */
export function normalizeSourceProgramRequest(input: NativeSourceProgramRequest): NativeSourceProgramRequest {
  const hasOutput = !!input && Object.hasOwn(input, "audioOutput");
  const hasVideo = !!input && Object.hasOwn(input, "videoOutput");
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join() !== `allowHardwareAcceleration,${hasOutput ? "audioOutput," : ""}packagerId,requestedRenditions,roomId,title,${hasVideo ? "videoOutput," : ""}visibility`
    || !/^[a-z0-9][a-z0-9-]{5,47}$/.test(input.roomId) || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(input.packagerId)
    || typeof input.title !== "string" || !input.title.trim() || input.title.length > 80
    || /[\u0000-\u001f\u007f]/.test(input.title) || !["private", "unlisted", "public"].includes(input.visibility)
    || !Number.isSafeInteger(input.requestedRenditions) || input.requestedRenditions < 1 || input.requestedRenditions > 3
    || typeof input.allowHardwareAcceleration !== "boolean") throw new Error("native_source_program_start_denied");
  return Object.freeze({ ...input, title: input.title.trim(),
    ...(hasOutput ? { audioOutput: normalizeSourceAudioOutput(input.audioOutput) } : {}),
    ...(hasVideo ? { videoOutput: normalizeSourceVideoOutput(input.videoOutput) } : {}) });
}
