/** Content checks only; source/session authority remains in MachineAvatarSource. */
export interface AvatarVideoContent {
  bytes: Uint8Array<ArrayBuffer>; sha256: string; frames: number;
  repeatMode: "loop" | "hold_last"; originKind: "upload" | "generated" | "licensed_pack";
  classification: "production" | "synthetic" | "test_only";
}

export function parseAvatarVideo(value: unknown): AvatarVideoContent {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "classification,frames,mp4,originKind,repeatMode,sha256") {
    throw new Error("meet_avatar_video_invalid");
  }
  const { mp4, sha256, frames, repeatMode, originKind, classification } = value as Record<string, unknown>;
  if (typeof mp4 !== "string" || !mp4.length || mp4.length > 2_000_000 || mp4.length % 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(mp4) || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
    || typeof frames !== "number" || !Number.isSafeInteger(frames) || frames < 2 || frames > 120
    || (repeatMode !== "loop" && repeatMode !== "hold_last")
    || (originKind !== "upload" && originKind !== "generated" && originKind !== "licensed_pack")
    || (classification !== "production" && classification !== "synthetic" && classification !== "test_only")
    || (originKind === "generated" && classification === "production")) throw new Error("meet_avatar_video_invalid");
  const raw = atob(mp4);
  if (raw.length < 16 || raw.length > 1_500_000 || btoa(raw) !== mp4 || raw.slice(4, 8) !== "ftyp") {
    throw new Error("meet_avatar_video_invalid");
  }
  return { bytes: Uint8Array.from(raw, c => c.charCodeAt(0)), sha256, frames, repeatMode, originKind, classification };
}

export function probeAvatarVideo(canPlay = () => document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"')) {
  let supported = false;
  try { const result = canPlay(); supported = result === "probably" || result === "maybe"; } catch { /* No fallback. */ }
  return Object.freeze({ schema: "ananta.meet-avatar-video-probe.v1", profile: "persona-video-v1", mp4H264: supported });
}
