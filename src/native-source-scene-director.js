import { NativeSourceSceneError, sameNativeSceneContext } from "./native-source-scene-broker.js";
import { supportsNativeSourceSceneV1 } from "./native-packager-policy.js";

const fail = (code, status = 409) => { throw new NativeSourceSceneError(code, status); };
const positive = n => Number.isSafeInteger(n) && n > 0;

export function normalizeNativeSceneDirectorInput(value) {
  const fields = ["requestVersion", "deviceFingerprint", "action", "expectedProgramRevision", "expectedProgramEpoch"];
  if (value?.action === "apply") fields.push("trigger", "expectedSceneRevision", "layout", "sourceLeaseIds", "activeSourceLeaseId");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some(k => !fields.includes(k))
    || value.requestVersion !== 1 || !["query", "apply"].includes(value.action)
    || typeof value.deviceFingerprint !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceFingerprint)
    || !positive(value.expectedProgramRevision) || !positive(value.expectedProgramEpoch)
    || value.action === "apply" && value.trigger !== "user-action") fail("invalid_native_scene_request", 400);
  return Object.freeze({ ...value, ...(value.action === "apply" && Array.isArray(value.sourceLeaseIds)
    ? { sourceLeaseIds: Object.freeze([...value.sourceLeaseIds]) } : {}) });
}

/** Human controller adapter; no new policy owner, capture, key or source consent. */
export async function directNativeSourceScene({ identity, ownerPrincipal, programId, input: raw, getMember,
  runtime, assignments, control, broker, signal, clock = Date.now }) {
  const input = normalizeNativeSceneDirectorInput(raw);
  let observedContext;
  const authorize = now => {
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
    const assignment = assignments.sourceContext(writer.packagerRef, now);
    if (!assignment || assignment.inputMode !== "trusted-sframe-v1" || assignment.programId !== programId
      || assignment.roomId !== member.roomId || assignment.programEpoch !== writer.programEpoch
      || assignment.fencingRevision !== writer.fencingRevision || assignment.leaseId !== writer.leaseId) fail("native_scene_assignment_changed");
    const socket = control.socketFor(writer.packagerRef);
    if (!socket || control.connection(socket)?.ownerPrincipal !== ownerPrincipal) fail("native_scene_disconnected", 503);
    const context = { member, socket, generation: candidate.generation, packagerId: writer.packagerRef,
      assignmentId: assignment.assignmentId, programId, programRevision: writer.programRevision,
      programEpoch: writer.programEpoch, leaseId: writer.leaseId, fencingRevision: writer.fencingRevision,
      expiresAt: Math.min(writer.expiresAt, assignment.expiresAt, candidate.capability.expiresAt) };
    observedContext = context;
    return context;
  };
  const selection = input.action === "query" ? null : Object.fromEntries(
    ["expectedSceneRevision", "layout", "sourceLeaseIds", "activeSourceLeaseId"].map(k => [k, input[k]]));
  const result = await broker.request(selection, authorize, signal);
  const previous = observedContext;
  if (signal?.aborted || !sameNativeSceneContext(previous, authorize(clock()))) fail("native_scene_authority_changed");
  // Native scope and reply have been checked. Do not expose writer leases or wire command IDs to the UI.
  const common = { sceneControlVersion: 1, programId, programRevision: observedContext.programRevision,
    programEpoch: result.programEpoch, packagerId: observedContext.packagerId,
    assignmentId: result.assignmentId, fencingRevision: result.fencingRevision };
  if (result.type === "source-program-scene-state") return Object.freeze({ ...common, outcome: "observed",
    observedAt: result.observedAt, sceneRevision: result.sceneRevision, layout: result.layout,
    sourceLeaseIds: result.sourceLeaseIds, activeSourceLeaseId: result.activeSourceLeaseId, availableSources: result.availableSources });
  if (result.type === "source-program-scene-applied") return Object.freeze({ ...common, outcome: "applied",
    appliedAt: result.appliedAt, sceneRevision: result.sceneRevision });
  return Object.freeze({ ...common, outcome: "rejected", observedAt: result.observedAt, reasonCode: result.reasonCode });
}
