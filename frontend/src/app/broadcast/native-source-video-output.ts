export interface NativeSourceVideoOutput {
  readonly profile: "balanced-v1" | "economy-v1" | "screen-v1";
}

export function normalizeSourceVideoOutput(value: unknown): NativeSourceVideoOutput {
  const v = value as Partial<NativeSourceVideoOutput> | null;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 1 || !Object.hasOwn(v, "profile")
    || !["balanced-v1", "economy-v1", "screen-v1"].includes(v.profile ?? "")) {
    throw new Error("invalid_native_source_video_output");
  }
  return Object.freeze({ profile: v.profile! });
}
