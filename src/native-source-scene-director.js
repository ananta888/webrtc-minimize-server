import { NativeSourceSceneError, sameNativeSceneContext } from "./native-source-scene-broker.js";
import { supportsNativeSourceSceneV1, supportsNativeSourceSceneV2 } from "./native-packager-policy.js";
import { observeNativeDirectorApply } from "./native-director-history.js";

const fail = (code, status = 409) => { throw new NativeSourceSceneError(code, status); };
const positive = n => Number.isSafeInteger(n) && n > 0;

export function normalizeNativeSceneDirectorInput(value) {
  const fields = ["requestVersion", "deviceFingerprint", "action", "expectedProgramRevision", "expectedProgramEpoch"];
  if (value?.action === "apply") fields.push("trigger", "expectedSceneRevision", "layout", "sourceLeaseIds", "activeSourceLeaseId");
  if (value?.action === "apply" && value.requestVersion === 2) fields.push("sourceFits");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some(k => !fields.includes(k))
    || ![1, 2].includes(value.requestVersion) || !["query", "apply"].includes(value.action)
    || typeof value.deviceFingerprint !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceFingerprint)
    || !positive(value.expectedProgramRevision) || !positive(value.expectedProgramEpoch)
    || value.action === "apply" && (value.trigger !== "user-action" || value.requestVersion === 2
      && (!Array.isArray(value.sourceFits) || !Array.isArray(value.sourceLeaseIds) || value.sourceFits.length !== value.sourceLeaseIds.length
        || value.sourceFits.length > 20 || value.sourceFits.some(fit => !["contain", "cover"].includes(fit))))) fail("invalid_native_scene_request", 400);
  return Object.freeze({ ...value, ...(value.action === "apply" && Array.isArray(value.sourceLeaseIds)
    ? { sourceLeaseIds: Object.freeze([...value.sourceLeaseIds]) } : {}),
    ...(value.action === "apply" && value.requestVersion === 2 ? { sourceFits: Object.freeze([...value.sourceFits]) } : {}) });
}

/** Shared human director policy; callers must first validate their closed input contract. */
export function nativeSceneAuthorizer({ identity, ownerPrincipal, programId, input, getMember, runtime, assignments, control }) {
  return now => {
    const member = getMember();
    if (!member || member.machine || member.principal !== ownerPrincipal || member.deviceFingerprint !== input.deviceFingerprint) {
      fail("native_scene_controller_required", 403);
    }
    const writer = runtime.nativeSourceWriterContext(identity, member, programId, now);
    if (!writer || !["live", "degraded"].includes(writer.state)
      || writer.programRevision !== input.expectedProgramRevision || writer.programEpoch !== input.expectedProgramEpoch) {
      fail("native_scene_program_changed");
    }
    const candidate = control.sourceContext(ownerPrincipal, writer.packagerRef, member.roomId, now);
    if (!supportsNativeSourceSceneV1(candidate.capability)) fail("native_scene_unsupported");
    const sceneControlVersion = input.requestVersion === 2 && supportsNativeSourceSceneV2(candidate.capability) ? 2 : 1;
    if (input.action === "apply" && input.requestVersion !== sceneControlVersion) fail("native_scene_unsupported");
    const assignment = assignments.sourceContext(writer.packagerRef, now);
    if (!assignment || assignment.inputMode !== "trusted-sframe-v1" || assignment.programId !== programId
      || assignment.roomId !== member.roomId || assignment.programEpoch !== writer.programEpoch
      || assignment.fencingRevision !== writer.fencingRevision || assignment.leaseId !== writer.leaseId) fail("native_scene_assignment_changed");
    const socket = control.socketFor(writer.packagerRef);
    if (!socket || control.connection(socket)?.ownerPrincipal !== ownerPrincipal) fail("native_scene_disconnected", 503);
    const context = { member, socket, generation: candidate.generation, sceneControlVersion, packagerId: writer.packagerRef,
      assignmentId: assignment.assignmentId, programId, programRevision: writer.programRevision,
      programEpoch: writer.programEpoch, leaseId: writer.leaseId, fencingRevision: writer.fencingRevision,
      expiresAt: Math.min(writer.expiresAt, assignment.expiresAt, candidate.capability.expiresAt) };
    if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(context.expiresAt) || context.expiresAt <= now) {
      fail("native_scene_unavailable");
    }
    return context;
  };
}

/** Human controller adapter; no new policy owner, capture, key or source consent. */
export async function directNativeSourceScene({ identity, ownerPrincipal, programId, input: raw, getMember,
  runtime, assignments, control, broker, signal, clock = Date.now }) {
  const input = normalizeNativeSceneDirectorInput(raw);
  let observedContext;
  const check = nativeSceneAuthorizer({ identity, ownerPrincipal, programId, input, getMember, runtime, assignments, control });
  const authorize = now => (observedContext = check(now));
  const selection = input.action === "query" ? null : Object.fromEntries(
    ["expectedSceneRevision", "layout", "sourceLeaseIds", "activeSourceLeaseId", ...(input.requestVersion === 2 ? ["sourceFits"] : [])].map(k => [k, input[k]]));
  const result = await broker.request(selection, authorize, signal);
  const previous = observedContext, checkedAt = clock();
  if (signal?.aborted || !sameNativeSceneContext(previous, authorize(checkedAt))) fail("native_scene_authority_changed");
  if (result.version !== observedContext.sceneControlVersion) fail("native_scene_reply_invalid");
  // Native scope and reply have been checked. Do not expose writer leases or wire command IDs to the UI.
  const common = { sceneControlVersion: result.version, programId, programRevision: observedContext.programRevision,
    programEpoch: result.programEpoch, packagerId: observedContext.packagerId,
    assignmentId: result.assignmentId, fencingRevision: result.fencingRevision };
  if (result.type === "source-program-scene-state") return Object.freeze({ ...common, outcome: "observed",
    observedAt: result.observedAt, sceneRevision: result.sceneRevision, layout: result.layout,
    sourceLeaseIds: result.sourceLeaseIds, activeSourceLeaseId: result.activeSourceLeaseId, availableSources: result.availableSources,
    ...(result.version === 2 ? { sourceFits: result.sourceFits } : {}) });
  if (result.type === "source-program-scene-applied") {
    observeNativeDirectorApply(runtime, identity, observedContext, "scene-applied", result.sceneRevision, checkedAt);
    return Object.freeze({ ...common, outcome: "applied", appliedAt: result.appliedAt, sceneRevision: result.sceneRevision });
  }
  return Object.freeze({ ...common, outcome: "rejected", observedAt: result.observedAt, reasonCode: result.reasonCode });
}
