// Instance-wide planning limits across admitted native assignments. These are
// not measurements of available host RAM/CPU, provider cost or viewer egress.
export const NATIVE_PACKAGER_RESOURCE_DEFAULTS = Object.freeze({
  cpuUnits: 512,
  memoryMiB: 16_384,
  encoderSlots: 48,
  gpuSlots: 16,
  egressBitsPerSecond: 100_000_000,
});
export const NATIVE_PACKAGER_RESOURCE_ENV = Object.freeze({
  cpuUnits: "BROADCAST_NATIVE_CPU_UNITS",
  memoryMiB: "BROADCAST_NATIVE_MEMORY_MIB",
  encoderSlots: "BROADCAST_NATIVE_ENCODER_SLOTS",
  gpuSlots: "BROADCAST_NATIVE_GPU_SLOTS",
  egressBitsPerSecond: "BROADCAST_NATIVE_EGRESS_BITS_PER_SECOND",
});
const FIELDS = Object.keys(NATIVE_PACKAGER_RESOURCE_DEFAULTS);

export function normalizeNativePackagerResources(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !FIELDS.includes(key))) throw new TypeError("invalid_native_packager_resource_budget");
  const limits = { ...NATIVE_PACKAGER_RESOURCE_DEFAULTS, ...value };
  if (Object.values(limits).some(limit => !Number.isSafeInteger(limit) || limit < 0 || limit > 1_000_000_000)) {
    throw new TypeError("invalid_native_packager_resource_budget");
  }
  return Object.freeze(limits);
}

export function nativePackagerResourceDemand(admission) {
  if (!admission || ![1, 2, 3].includes(admission.admissionVersion)
    || admission.softwareFallback !== "libx264"
    || !["libx264", "h264_nvenc", "h264_videotoolbox"].includes(admission.videoEncoder)
    || !Array.isArray(admission.renditions) || admission.renditions.length < 1 || admission.renditions.length > 3) {
    throw new TypeError("invalid_native_packager_resource_demand");
  }
  let pixels = 0, bitrate = 0;
  for (const r of admission.renditions) {
    if (!r || [r.width, r.height, r.framesPerSecond, r.videoBitsPerSecond, r.audioBitsPerSecond]
      .some(value => !Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000)) {
      throw new TypeError("invalid_native_packager_resource_demand");
    }
    pixels += r.width * r.height * r.framesPerSecond;
    bitrate += r.videoBitsPerSecond + r.audioBitsPerSecond;
  }
  if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(bitrate)) throw new TypeError("invalid_native_packager_resource_demand");
  const count = admission.renditions.length;
  // Reserve the full software fallback, even for a hardware-selected encoder.
  const demand = { cpuUnits: Math.max(1, Math.ceil(pixels / 1_000_000)), memoryMiB: 128 + 96 * count,
    encoderSlots: count, gpuSlots: admission.videoEncoder === "libx264" ? 0 : count,
    egressBitsPerSecond: Math.ceil(bitrate * 1.15) };
  if (Object.values(demand).some(value => !Number.isSafeInteger(value))) throw new TypeError("invalid_native_packager_resource_demand");
  return Object.freeze(demand);
}

export class NativePackagerResourceBudget {
  #limits;
  constructor(limits) { this.#limits = normalizeNativePackagerResources(limits); }
  allows(candidate, occupied) {
    if (!Array.isArray(occupied) || occupied.length > 20_000) return false;
    const used = Object.fromEntries(FIELDS.map(field => [field, 0]));
    try {
      for (const admission of [...occupied, candidate]) {
        const demand = nativePackagerResourceDemand(admission);
        for (const field of FIELDS) {
          used[field] += demand[field];
          if (!Number.isSafeInteger(used[field]) || used[field] > this.#limits[field]) return false;
        }
      }
      return true;
    } catch { return false; }
  }
}
