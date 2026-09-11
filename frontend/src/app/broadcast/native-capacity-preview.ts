import { BroadcastBrowserPortError } from "./broadcast-ports";
import type { NativeSourceProgramRequest } from "./native-source-program-controller";
import type { NativeControlHttpPorts } from "./native-control-http-ports";
import { normalizeSourceAudioOutput } from "./native-source-audio-output";
import { normalizeSourceVideoOutput } from "./native-source-video-output";

interface NativeCapacityDetails {
  reserved: false; costStatus: "unknown";
  capacityClass: "origin-small" | "cdn-medium" | "cdn-large";
  observedAt: number; expiresAt: number; requestedRenditions: number; reduced: boolean;
  videoEncoder: "libx264" | "h264_nvenc" | "h264_videotoolbox";
  demand: { cpuUnits: number; memoryMiB: number; encoderSlots: number; gpuSlots: number; egressBitsPerSecond: number };
  renditions: readonly { id: string; width: number; height: number; framesPerSecond: number;
    videoBitsPerSecond: number; audioBitsPerSecond: number; audioChannels: number }[];
}
export type NativeCapacityPreview = NativeCapacityDetails & ({ schema: "ananta.native-capacity-preview.v1" }
  | { schema: "ananta.native-capacity-preview.v2"; programSlots: "available" });
const exact = (v: any, fields: string[]) => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const int = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const invalid = () => { throw new BroadcastBrowserPortError("invalid_native_capacity_preview"); };

export function parseNativeCapacityPreview(value: unknown, requested: number, version: 1 | 2 = 1): NativeCapacityPreview {
  const v = value as NativeCapacityPreview;
  if (!exact(v, ["schema", "reserved", "costStatus", "capacityClass", "observedAt", "expiresAt", "requestedRenditions", "reduced", "videoEncoder", "demand", "renditions",
      ...(version === 2 ? ["programSlots"] : [])]) || ![1, 2].includes(version)
    || v.schema !== `ananta.native-capacity-preview.v${version}` || v.reserved !== false || v.costStatus !== "unknown"
    || !["origin-small", "cdn-medium", "cdn-large"].includes(v.capacityClass)
    || v.schema === "ananta.native-capacity-preview.v2" && v.programSlots !== "available"
    || !int(v.observedAt, 1, Number.MAX_SAFE_INTEGER) || !int(v.expiresAt, v.observedAt + 1, v.observedAt + 5000)
    || !int(requested, 1, 3) || v.requestedRenditions !== requested
    || !["libx264", "h264_nvenc", "h264_videotoolbox"].includes(v.videoEncoder)
    || !Array.isArray(v.renditions) || v.renditions.length < 1 || v.renditions.length > requested
    || v.reduced !== (v.renditions.length < requested)
    || !exact(v.demand, ["cpuUnits", "memoryMiB", "encoderSlots", "gpuSlots", "egressBitsPerSecond"])) return invalid();
  let pixels = 0, rate = 0;
  v.renditions.forEach((r, index) => {
    if (!exact(r, ["id", "width", "height", "framesPerSecond", "videoBitsPerSecond", "audioBitsPerSecond", "audioChannels"])
      || r.id !== ["low", "medium", "high"][index] || !int(r.width, 1, 1280) || !int(r.height, 1, 720)
      || !int(r.framesPerSecond, 1, 30) || !int(r.videoBitsPerSecond, 1, 2400000)
      || !int(r.audioBitsPerSecond, 16000, 320000) || !int(r.audioChannels, 1, 2)) return invalid();
    pixels += r.width * r.height * r.framesPerSecond; rate += r.videoBitsPerSecond + r.audioBitsPerSecond;
  });
  const count = v.renditions.length;
  if (v.demand.cpuUnits !== Math.max(1, Math.ceil(pixels / 1000000)) || v.demand.memoryMiB !== 128 + 96 * count
    || v.demand.encoderSlots !== count || v.demand.gpuSlots !== (v.videoEncoder === "libx264" ? 0 : count)
    || v.demand.egressBitsPerSecond !== Math.ceil(rate * 1.15)) return invalid();
  return Object.freeze({ ...v, demand: Object.freeze({ ...v.demand }), renditions: Object.freeze(v.renditions.map(r => Object.freeze({ ...r }))) });
}

export async function requestNativeCapacityPreview(request: NativeSourceProgramRequest, signal: AbortSignal,
  ports: NativeControlHttpPorts): Promise<NativeCapacityPreview> {
  signal.throwIfAborted();
  const fingerprint = ports.fingerprint();
  if (!fingerprint || !/^[A-Za-z0-9_-]{43}$/.test(fingerprint) || !/^[a-z0-9][a-z0-9-]{5,47}$/.test(request.roomId)
    || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(request.packagerId) || !int(request.requestedRenditions, 1, 3)
    || typeof request.allowHardwareAcceleration !== "boolean") return invalid();
  const audio = request.audioOutput === undefined ? undefined : normalizeSourceAudioOutput(request.audioOutput);
  const video = request.videoOutput === undefined ? undefined : normalizeSourceVideoOutput(request.videoOutput);
  const response = await fetch("/api/broadcasts/native-capacity-preview", {
    method: "POST", headers: { "content-type": "application/json", ...ports.authorizationHeader() },
    credentials: "same-origin", cache: "no-store", redirect: "error", signal,
    body: JSON.stringify({ previewVersion: 2, requestVersion: video ? 3 : audio ? 2 : 1, trigger: "user-action", roomId: request.roomId,
      packagerId: request.packagerId, deviceFingerprint: fingerprint, requestedRenditions: request.requestedRenditions,
      allowHardwareAcceleration: request.allowHardwareAcceleration,
      ...(video ? { videoOutput: video, audioOutput: audio ?? null } : audio ? { audioOutput: audio } : {}) }),
  });
  if (!response.ok) throw ports.responseError(response, "native_capacity_preview_unavailable");
  const value = await ports.readJson(response, "invalid_native_capacity_preview", 4096);
  signal.throwIfAborted();
  return parseNativeCapacityPreview(value, request.requestedRenditions, 2);
}
