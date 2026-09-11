import { broadcastSubjectRef, broadcastTenantRef } from "./broadcast-identifiers.js";

function observe(runtime, identity, context, event, now) {
  try {
    runtime.observeProgramAction?.({ tenantId: broadcastTenantRef(identity.issuer), ownerSubjectRef: broadcastSubjectRef(identity),
      roomId: context.member.roomId, programId: context.programId, programEpoch: context.programEpoch }, event, now);
  } catch { /* Journal availability must not change the outcome of a completed command. */ }
}

/** Called only after the director's final current-authority/ACK checks. */
export function observeNativeDirectorApply(runtime, identity, context, kind, revision, now) {
  observe(runtime, identity, context, { kind, sourceKind: null, reason: null, controlRevision: revision }, now);
}

/** Same post-check position as apply; the fixed reason code is implied by the kind. */
export function observeNativeDirectorReject(runtime, identity, context, kind, now) {
  observe(runtime, identity, context, { kind, sourceKind: null, reason: null, controlRevision: null }, now);
}
