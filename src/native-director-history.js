import { broadcastSubjectRef, broadcastTenantRef } from "./broadcast-identifiers.js";

/** Called only after the director's final current-authority/ACK checks. */
export function observeNativeDirectorApply(runtime, identity, context, kind, revision, now) {
  try {
    runtime.observeProgramAction?.({ tenantId: broadcastTenantRef(identity.issuer), ownerSubjectRef: broadcastSubjectRef(identity),
      roomId: context.member.roomId, programId: context.programId, programEpoch: context.programEpoch },
    { kind, sourceKind: null, reason: null, controlRevision: revision }, now);
  } catch { /* Journal availability must not change the outcome of an applied command. */ }
}
