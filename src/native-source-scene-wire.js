import { parseMachineTrustJson } from "./machine-trust-json.js";
import { normalizeNativeSourceSceneReceipt } from "./native-source-scene.js";
import { normalizeNativeSourceSceneState, normalizeNativeSourceSceneRejection } from "./native-source-scene-query.js";

export const NATIVE_SCENE_REPLIES = Object.freeze([
  "source-program-scene-state", "source-program-scene-applied", "source-program-scene-rejected",
]);

/** Structural validation only. The broker separately checks actual request/time/socket authority. */
export function parseNativeSourceSceneReply(raw) {
  try {
    if (Buffer.byteLength(raw) > 16384) throw new Error();
    const text = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw);
    // This existing pure JSON utility rejects duplicate/escaped names and excessive depth.
    const value = parseMachineTrustJson(text, 16384);
    const time = value.type === "source-program-scene-applied" ? value.appliedAt : value.observedAt;
    const scope = Object.fromEntries(["commandId", "assignmentId", "programId", "programEpoch", "leaseId", "fencingRevision"]
      .map(key => [key, value[key]]));
    const query = { version: value.version, type: "source-program-scene-query", ...scope, issuedAt: time, expiresAt: time + 1 };
    const command = { ...query, type: "source-program-scene", expectedSceneRevision: value.sceneRevision - 1,
      layout: "waiting-slate", sourceLeaseIds: [], activeSourceLeaseId: "", ...(value.version === 2 ? { sourceFits: [] } : {}) };
    if (value.type === "source-program-scene-state") return normalizeNativeSourceSceneState(value, query, time);
    if (value.type === "source-program-scene-applied") return normalizeNativeSourceSceneReceipt(value, command, time);
    if (value.type === "source-program-scene-rejected") {
      return normalizeNativeSourceSceneRejection(value, { ...command, expectedSceneRevision: 1 }, time);
    }
  } catch { /* No raw input or parser error escapes the control boundary. */ }
  throw new Error("invalid_native_source_scene_reply");
}
