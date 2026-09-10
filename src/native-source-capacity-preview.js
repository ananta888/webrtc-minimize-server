import { broadcastSubjectRef, broadcastTenantRef, oidcPrincipal } from "./broadcast-identifiers.js";
import { NativePackagerPolicyError } from "./native-packager-policy.js";
import { nativePackagerResourceDemand } from "./native-packager-resource-budget.js";

const fail = (code, status = 400) => { throw new NativePackagerPolicyError(code, status); };

/** A read-only native admission observation, never a program, grant or reservation.
 * Internal inert IDs satisfy the admission contract; none leave this function.
 * Real start still allocates its own IDs and checks every budget independently. */
export function previewNativeSourceCapacity(identity, member, input, assignments, now = Date.now()) {
  const fields = new Set(["requestVersion", "trigger", "roomId", "packagerId", "deviceFingerprint",
    "requestedRenditions", "allowHardwareAcceleration",
    ...([2, 3].includes(input?.requestVersion) ? ["audioOutput"] : []),
    ...(input?.requestVersion === 3 ? ["videoOutput"] : [])]);
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== fields.size || Object.keys(input).some(key => !fields.has(key))
    || ![1, 2, 3].includes(input.requestVersion) || input.trigger !== "user-action"
    || typeof input.roomId !== "string" || !/^[a-z0-9][a-z0-9-]{5,47}$/.test(input.roomId)
    || typeof input.packagerId !== "string" || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(input.packagerId)
    || typeof input.deviceFingerprint !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.deviceFingerprint)
    || !Number.isSafeInteger(input.requestedRenditions) || input.requestedRenditions < 1 || input.requestedRenditions > 3
    || typeof input.allowHardwareAcceleration !== "boolean") fail("invalid_native_capacity_preview");
  if (!identity || identity.machineExpiresAt || !Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= now) {
    fail("broadcast_authentication_required", 401);
  }
  const principal = oidcPrincipal(identity);
  if (!member || member.machine || member.authenticated !== true || member.principal !== principal || member.creator !== true
    || member.roomId !== input.roomId || member.deviceFingerprint !== input.deviceFingerprint) {
    fail("broadcast_program_owner_membership_required", 403);
  }
  const admission = assignments.admitSourceProgram(principal, input.packagerId, {
    requestVersion: input.requestVersion, trigger: input.trigger,
    tenantId: broadcastTenantRef(identity.issuer), ownerSubjectRef: broadcastSubjectRef(identity), roomId: input.roomId,
    programId: "prg_capacity_preview", programEpoch: 1, resourceRef: "res_capacity_preview",
    requestedRenditions: input.requestedRenditions, allowHardwareAcceleration: input.allowHardwareAcceleration,
    ...([2, 3].includes(input.requestVersion) ? { audioOutput: input.audioOutput } : {}),
    ...(input.requestVersion === 3 ? { videoOutput: input.videoOutput } : {}),
  }, member.id, now);
  return Object.freeze({ schema: "ananta.native-capacity-preview.v1", reserved: false, costStatus: "unknown",
    observedAt: now, expiresAt: Math.min(now + 5000, identity.expiresAt),
    requestedRenditions: input.requestedRenditions, reduced: admission.renditions.length < input.requestedRenditions,
    videoEncoder: admission.videoEncoder, demand: nativePackagerResourceDemand(admission),
    renditions: Object.freeze(admission.renditions.map(r => Object.freeze({ id: r.id, width: r.width, height: r.height,
      framesPerSecond: r.framesPerSecond, videoBitsPerSecond: r.videoBitsPerSecond,
      audioBitsPerSecond: r.audioBitsPerSecond, audioChannels: r.audioChannels }))),
  });
}
