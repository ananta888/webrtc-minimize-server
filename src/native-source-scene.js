const fields = ["version", "type", "commandId", "assignmentId", "programId", "programEpoch", "leaseId",
  "fencingRevision", "expectedSceneRevision", "layout", "sourceLeaseIds", "activeSourceLeaseId", "issuedAt", "expiresAt"];
export const NATIVE_SOURCE_SCENE_LAYOUTS = Object.freeze([
  "single", "screen-presenter", "side-by-side", "active-speaker", "grid", "waiting-slate", "end-slate",
]);
const ref = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`).test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = () => { throw new Error("invalid_native_source_scene"); };

/** Metadata only. A parsed command is not director, source or socket authority. */
export function normalizeNativeSourceScene(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))
    || value.version !== 1 || value.type !== "source-program-scene"
    || !ref(value.commandId, "scn") || !ref(value.assignmentId, "asn") || !ref(value.programId, "prg")
    || !ref(value.leaseId, "lea") || !positive(value.programEpoch) || !positive(value.fencingRevision)
    || !positive(value.expectedSceneRevision) || value.expectedSceneRevision === Number.MAX_SAFE_INTEGER
    || !NATIVE_SOURCE_SCENE_LAYOUTS.includes(value.layout)
    || !Array.isArray(value.sourceLeaseIds) || value.sourceLeaseIds.length > 20
    || value.sourceLeaseIds.some(id => !ref(id, "sls")) || new Set(value.sourceLeaseIds).size !== value.sourceLeaseIds.length
    || typeof value.activeSourceLeaseId !== "string"
    || value.activeSourceLeaseId !== "" && (!["single", "active-speaker"].includes(value.layout)
      || !value.sourceLeaseIds.includes(value.activeSourceLeaseId))
    || !positive(now) || !positive(value.issuedAt) || !positive(value.expiresAt)
    || value.issuedAt > now + 1000 || value.expiresAt <= now || value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > 4000) fail();
  return Object.freeze({ ...value, sourceLeaseIds: Object.freeze([...value.sourceLeaseIds]) });
}

/** Correlates a native application receipt, not current output or viewer delivery. */
export function normalizeNativeSourceSceneReceipt(value, request, now = Date.now()) {
  const command = normalizeNativeSourceScene(request, now);
  const scope = ["commandId", "assignmentId", "programId", "programEpoch", "leaseId", "fencingRevision"];
  const receiptFields = ["version", "type", ...scope, "sceneRevision", "appliedAt"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== receiptFields.length || Object.keys(value).some(key => !receiptFields.includes(key))
    || value.version !== 1 || value.type !== "source-program-scene-applied"
    || scope.some(key => value[key] !== command[key]) || value.sceneRevision !== command.expectedSceneRevision + 1
    || !positive(value.appliedAt) || value.appliedAt < command.issuedAt - 1000
    || value.appliedAt > now + 1000 || value.appliedAt >= command.expiresAt) fail();
  return Object.freeze({ ...value });
}
