import path from "node:path";

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TENANT = /^tn_[A-Za-z0-9_-]{16,64}$/;
const SUBJECT = /^sub_[A-Za-z0-9_-]{16,64}$/;
const ROOM = /^[A-Za-z0-9_-]{4,64}$/;
const PROGRAM = /^prg_[A-Za-z0-9_-]{16,64}$/;
const RESOURCE = /^res_[A-Za-z0-9_-]{16,64}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,64}$/;

export class NativePackagerPolicyError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "NativePackagerPolicyError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) { throw new NativePackagerPolicyError(code, status); }

const RENDITIONS = Object.freeze([
  Object.freeze({ id: "low", width: 640, height: 360, framesPerSecond: 15, videoBitsPerSecond: 500_000, audioBitsPerSecond: 64_000 }),
  Object.freeze({ id: "medium", width: 960, height: 540, framesPerSecond: 24, videoBitsPerSecond: 1_100_000, audioBitsPerSecond: 96_000 }),
  Object.freeze({ id: "high", width: 1280, height: 720, framesPerSecond: 30, videoBitsPerSecond: 2_400_000, audioBitsPerSecond: 128_000 }),
]);

export function normalizeNativePackagerCapability(value, now = Date.now()) {
  const fields = new Set([
    "capabilityVersion", "agentId", "tenantId", "ownerSubjectRef", "deviceRef", "agentVersion",
    "ffmpegVersion", "videoEncoders", "audioEncoders", "hardwareClass", "cpuClass", "gpuClass",
    "uploadClass", "energyClass", "health", "maximumRenditions", "maximumPixelsPerSecond",
    "consentedRoomIds", "observedAt", "expiresAt",
  ]);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((key) => !fields.has(key))
    || value.capabilityVersion !== 1 || !ID.test(value.agentId || "") || !TENANT.test(value.tenantId || "")
    || !SUBJECT.test(value.ownerSubjectRef || "") || !/^dev_[A-Za-z0-9_-]{16,64}$/.test(value.deviceRef || "")
    || !VERSION.test(value.agentVersion || "") || !VERSION.test(value.ffmpegVersion || "")
    || !Array.isArray(value.videoEncoders) || value.videoEncoders.length > 8
    || value.videoEncoders.some((codec) => !new Set(["libx264", "h264_nvenc", "h264_vaapi", "h264_videotoolbox"]).has(codec))
    || !Array.isArray(value.audioEncoders) || value.audioEncoders.length > 4
    || value.audioEncoders.some((codec) => codec !== "aac")
    || !new Set(["small", "medium", "large"]).has(value.hardwareClass)
    || !new Set(["low", "medium", "high"]).has(value.cpuClass)
    || !new Set(["none", "integrated", "dedicated"]).has(value.gpuClass)
    || !new Set(["under-5mbit", "5-15mbit", "over-15mbit"]).has(value.uploadClass)
    || !new Set(["battery", "ac-limited", "ac"]).has(value.energyClass)
    || !new Set(["healthy", "degraded", "draining"]).has(value.health)
    || !Number.isSafeInteger(value.maximumRenditions) || value.maximumRenditions < 1 || value.maximumRenditions > 3
    || !Number.isSafeInteger(value.maximumPixelsPerSecond) || value.maximumPixelsPerSecond < 640 * 360 * 10
    || value.maximumPixelsPerSecond > 1920 * 1080 * 60 * 3
    || !Array.isArray(value.consentedRoomIds) || value.consentedRoomIds.length > 20
    || new Set(value.consentedRoomIds).size !== value.consentedRoomIds.length
    || value.consentedRoomIds.some((roomId) => !ROOM.test(roomId))
    || !Number.isSafeInteger(value.observedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.observedAt > now + 5_000 || value.expiresAt <= now || value.expiresAt > value.observedAt + 60_000) {
    fail("invalid_native_packager_capability");
  }
  return Object.freeze({
    ...value,
    videoEncoders: Object.freeze([...new Set(value.videoEncoders)]),
    audioEncoders: Object.freeze([...new Set(value.audioEncoders)]),
    consentedRoomIds: Object.freeze([...value.consentedRoomIds]),
  });
}

export function admitNativePackager(capabilityValue, request, now = Date.now()) {
  const capability = normalizeNativePackagerCapability(capabilityValue, now);
  const fields = new Set([
    "requestVersion", "trigger", "tenantId", "ownerSubjectRef", "roomId", "programId", "programEpoch",
    "resourceRef", "requestedRenditions", "allowHardwareAcceleration",
  ]);
  if (!request || typeof request !== "object" || Array.isArray(request)
    || Object.keys(request).length !== fields.size || Object.keys(request).some((key) => !fields.has(key))
    || request.requestVersion !== 1 || request.trigger !== "user-action"
    || request.tenantId !== capability.tenantId || request.ownerSubjectRef !== capability.ownerSubjectRef
    || !ROOM.test(request.roomId || "") || !PROGRAM.test(request.programId || "")
    || !Number.isSafeInteger(request.programEpoch) || request.programEpoch < 1
    || !RESOURCE.test(request.resourceRef || "")
    || !Number.isSafeInteger(request.requestedRenditions) || request.requestedRenditions < 1 || request.requestedRenditions > 3
    || typeof request.allowHardwareAcceleration !== "boolean") fail("invalid_native_packager_request");
  if (!capability.consentedRoomIds.includes(request.roomId)) fail("native_packager_room_consent_required", 403);
  if (capability.health !== "healthy" || capability.energyClass === "battery") fail("native_packager_unavailable", 503);
  if (!capability.audioEncoders.includes("aac") || !capability.videoEncoders.includes("libx264")) {
    fail("native_packager_software_fallback_unavailable", 503);
  }
  const uploadLimit = capability.uploadClass === "over-15mbit" ? 3 : capability.uploadClass === "5-15mbit" ? 2 : 1;
  const cpuLimit = capability.cpuClass === "high" ? 3 : capability.cpuClass === "medium" ? 2 : 1;
  const count = Math.min(request.requestedRenditions, capability.maximumRenditions, uploadLimit, cpuLimit);
  const selected = RENDITIONS.slice(0, count).filter((rendition) => (
    rendition.width * rendition.height * rendition.framesPerSecond <= capability.maximumPixelsPerSecond
  ));
  if (selected.length < 1) fail("native_packager_capacity_rejected", 503);
  const hardwareEncoder = request.allowHardwareAcceleration
    ? capability.videoEncoders.find((encoder) => encoder !== "libx264") || null
    : null;
  return Object.freeze({
    admissionVersion: 1,
    agentId: capability.agentId,
    roomId: request.roomId,
    programId: request.programId,
    programEpoch: request.programEpoch,
    resourceRef: request.resourceRef,
    videoEncoder: hardwareEncoder || "libx264",
    softwareFallback: "libx264",
    audioEncoder: "aac",
    renditions: Object.freeze(selected),
    maximumQueueFrames: 60,
    keyframeIntervalSeconds: 2,
  });
}

export function nativePackagerFfmpegArguments(admission, outputRoot) {
  if (!admission || admission.admissionVersion !== 1 || !Array.isArray(admission.renditions)
    || admission.renditions.length < 1 || admission.renditions.length > 3
    || typeof outputRoot !== "string" || !path.isAbsolute(outputRoot)) fail("invalid_native_packager_pipeline");
  const output = path.resolve(outputRoot, admission.resourceRef);
  if (!output.startsWith(`${path.resolve(outputRoot)}${path.sep}`)) fail("invalid_native_packager_pipeline");
  const splits = admission.renditions.map((_, index) => `[v${index}]`).join("");
  const filters = [`[0:v]split=${admission.renditions.length}${splits}`];
  admission.renditions.forEach((rendition, index) => {
    filters.push(`[v${index}]scale=w=${rendition.width}:h=${rendition.height}:force_original_aspect_ratio=decrease,pad=${rendition.width}:${rendition.height}:(ow-iw)/2:(oh-ih)/2[v${index}out]`);
  });
  const args = ["-hide_banner", "-nostdin", "-loglevel", "warning", "-i", "pipe:0", "-filter_complex", filters.join(";")];
  admission.renditions.forEach((rendition, index) => {
    args.push("-map", `[v${index}out]`, "-map", "0:a:0?");
    args.push(`-c:v:${index}`, admission.videoEncoder, `-b:v:${index}`, String(rendition.videoBitsPerSecond),
      `-maxrate:v:${index}`, String(Math.round(rendition.videoBitsPerSecond * 1.15)),
      `-bufsize:v:${index}`, String(rendition.videoBitsPerSecond * 2), `-r:v:${index}`, String(rendition.framesPerSecond),
      `-g:v:${index}`, String(rendition.framesPerSecond * admission.keyframeIntervalSeconds), `-sc_threshold:v:${index}`, "0",
      `-c:a:${index}`, admission.audioEncoder, `-b:a:${index}`, String(rendition.audioBitsPerSecond));
  });
  const variants = admission.renditions.map((rendition, index) => `v:${index},a:${index},name:${rendition.id}`).join(" ");
  args.push("-f", "hls", "-hls_time", "1", "-hls_segment_type", "fmp4", "-hls_list_size", "7",
    "-hls_flags", "independent_segments+delete_segments+program_date_time",
    "-master_pl_name", "master.m3u8", "-var_stream_map", variants,
    path.join(output, "%v", "index.m3u8"));
  return Object.freeze({ command: "ffmpeg", args: Object.freeze(args), outputDirectory: output });
}
