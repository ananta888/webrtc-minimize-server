import { normalizeNativeSourceScene } from "./native-source-scene.js";

const scope = ["commandId", "assignmentId", "programId", "programEpoch", "leaseId", "fencingRevision"];
const queryFields = ["version", "type", ...scope, "issuedAt", "expiresAt"];
const fail = () => { throw new Error("invalid_native_source_scene_observation"); };
const closed = (v, keys) => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const base = query => ({ ...query, type: "source-program-scene", expectedSceneRevision: 1,
  layout: "waiting-slate", sourceLeaseIds: [], activeSourceLeaseId: "" });

export function normalizeNativeSourceSceneQuery(value, now = Date.now()) {
  if (!closed(value, queryFields) || value.type !== "source-program-scene-query") fail();
  normalizeNativeSourceScene(base(value), now);
  return Object.freeze({ ...value });
}

function correlation(value, request, type, fields, now) {
  if (!closed(value, ["version", "type", ...scope, "observedAt", ...fields]) || value.version !== 1
    || value.type !== type || scope.some(k => value[k] !== request[k])
    || !Number.isSafeInteger(value.observedAt) || value.observedAt < 1
    || value.observedAt < request.issuedAt - 1000 || value.observedAt > now + 1000
    || value.observedAt >= request.expiresAt) fail();
}

/** Actual native observation, never a continuing source permission or media ACK. */
export function normalizeNativeSourceSceneState(value, query, now = Date.now()) {
  const request = normalizeNativeSourceSceneQuery(query, now);
  correlation(value, request, "source-program-scene-state",
    ["sceneRevision", "layout", "sourceLeaseIds", "activeSourceLeaseId", "availableSources"], now);
  if (!Number.isSafeInteger(value.sceneRevision) || value.sceneRevision < 1) fail();
  normalizeNativeSourceScene({ ...base(request), layout: value.layout, sourceLeaseIds: value.sourceLeaseIds,
    activeSourceLeaseId: value.activeSourceLeaseId }, now);
  if (!Array.isArray(value.availableSources) || value.availableSources.length > 80
    || value.availableSources.some(s => !closed(s, ["sourceLeaseId", "sourceKind"])
      || typeof s.sourceLeaseId !== "string" || !/^sls_[A-Za-z0-9_-]{16,64}$/.test(s.sourceLeaseId)
      || !["camera", "screen"].includes(s.sourceKind))
    || new Set(value.availableSources.map(s => s.sourceLeaseId)).size !== value.availableSources.length) fail();
  return Object.freeze({ ...value, sourceLeaseIds: Object.freeze([...value.sourceLeaseIds]),
    availableSources: Object.freeze(value.availableSources.map(s => Object.freeze({ ...s }))) });
}

/** A benign refusal of this request; the director must query before retrying. */
export function normalizeNativeSourceSceneRejection(value, command, now = Date.now()) {
  const request = normalizeNativeSourceScene(command, now);
  correlation(value, request, "source-program-scene-rejected", ["reasonCode"], now);
  if (value.reasonCode !== "SCENE_NOT_APPLIED") fail();
  return Object.freeze({ ...value });
}
