import { parseMachineTrustJson } from "./machine-trust-json.js";
import { normalizeNativeSourceAudioReply } from "./native-source-audio.js";

export const NATIVE_AUDIO_REPLIES = Object.freeze([
  "source-program-audio-state", "source-program-audio-applied", "source-program-audio-rejected",
]);

/** Structural validation only; the broker must check actual request, time and socket. */
export function parseNativeSourceAudioReply(raw) {
  try {
    if (Buffer.byteLength(raw) > 16384) throw new Error();
    const text = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const value = parseMachineTrustJson(text, 16384);
    if (!NATIVE_AUDIO_REPLIES.includes(value.type)) throw new Error();
    const query = value.type === "source-program-audio-state";
    const now = value.type === "source-program-audio-applied" ? value.appliedAt : value.observedAt;
    const scope = Object.fromEntries(["commandId", "assignmentId", "programId", "programEpoch", "leaseId", "fencingRevision"].map(key => [key, value[key]]));
    const request = { version: 1, type: query ? "source-program-audio-query" : "source-program-audio", ...scope,
      issuedAt: now, expiresAt: now + 1, ...(query ? {} : {
        expectedAudioRevision: value.type === "source-program-audio-applied" ? value.audioRevision - 1 : 1,
        sources: [{ sourceLeaseId: "sls_0000000000000000", leftGainQ15: 0, rightGainQ15: 0, muted: true }],
      }) };
    return normalizeNativeSourceAudioReply(value, request, now);
  } catch { throw new Error("invalid_native_source_audio_reply"); }
}
