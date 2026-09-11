import { NativeSourceAudioError, sameNativeAudioContext } from "./native-source-audio-broker.js";
import { normalizeNativeAudioSelection } from "./native-source-audio.js";
import { supportsNativeSourceAudioV1, supportsNativeSourceAudioV2, supportsNativeSourceAudioV3 } from "./native-packager-policy.js";
import { observeNativeDirectorApply, observeNativeDirectorReject } from "./native-director-history.js";

const fail = (code, status = 409) => { throw new NativeSourceAudioError(code, status); };
const positive = n => Number.isSafeInteger(n) && n > 0;

export function normalizeNativeAudioDirectorInput(value) {
  const fields = ["requestVersion", "deviceFingerprint", "action", "expectedProgramRevision", "expectedProgramEpoch"];
  if (value?.action === "apply") fields.push("trigger", "expectedAudioRevision", "sources");
  if (value?.action === "apply" && value.requestVersion >= 2) fields.push("strategy");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some(k => !fields.includes(k))
    || ![1, 2, 3].includes(value.requestVersion) || !["query", "apply"].includes(value.action)
    || typeof value.deviceFingerprint !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceFingerprint)
    || !positive(value.expectedProgramRevision) || !positive(value.expectedProgramEpoch)
    || value.action === "apply" && value.trigger !== "user-action") fail("invalid_native_audio_request", 400);
  if (value.action === "query") return Object.freeze({ ...value });
  try { return Object.freeze({ ...value, ...normalizeNativeAudioSelection({ expectedAudioRevision: value.expectedAudioRevision, sources: value.sources,
    ...(value.requestVersion >= 2 ? { strategy: value.strategy } : {}) }, value.requestVersion) }); }
  catch { fail("invalid_native_audio_request", 400); }
}

/** Human authorization adapter; runtime remains owner of roles, room and writer policy. */
export async function directNativeSourceAudio({ identity, ownerPrincipal, programId, input: raw, getMember,
  runtime, assignments, control, broker, signal, clock = Date.now }) {
  const input = normalizeNativeAudioDirectorInput(raw);
  let observedContext;
  const authorize = now => {
    const member = getMember();
    if (!member || member.machine || member.principal !== ownerPrincipal || member.deviceFingerprint !== input.deviceFingerprint) fail("native_audio_controller_required", 403);
    const writer = runtime.nativeSourceWriterContext(identity, member, programId, now);
    if (!writer || !["live", "degraded"].includes(writer.state) || writer.programRevision !== input.expectedProgramRevision
      || writer.programEpoch !== input.expectedProgramEpoch) fail("native_audio_program_changed");
    const candidate = control.sourceContext(ownerPrincipal, writer.packagerRef, member.roomId, now);
    const supported = input.requestVersion === 3 ? supportsNativeSourceAudioV3(candidate.capability)
      : input.requestVersion === 2 ? supportsNativeSourceAudioV2(candidate.capability) : supportsNativeSourceAudioV1(candidate.capability);
    if (!supported) fail("native_audio_unsupported");
    const assignment = assignments.sourceContext(writer.packagerRef, now);
    if (!assignment || assignment.inputMode !== "trusted-sframe-v1" || assignment.programId !== programId || assignment.roomId !== member.roomId
      || assignment.programEpoch !== writer.programEpoch || assignment.fencingRevision !== writer.fencingRevision || assignment.leaseId !== writer.leaseId) fail("native_audio_assignment_changed");
    const socket = control.socketFor(writer.packagerRef);
    if (!socket || control.connection(socket)?.ownerPrincipal !== ownerPrincipal) fail("native_audio_disconnected", 503);
    const context = { member, socket, generation: candidate.generation, packagerId: writer.packagerRef, assignmentId: assignment.assignmentId,
      programId, programRevision: writer.programRevision, programEpoch: writer.programEpoch, leaseId: writer.leaseId, fencingRevision: writer.fencingRevision,
      expiresAt: Math.min(writer.expiresAt, assignment.expiresAt, candidate.capability.expiresAt) };
    observedContext = context;
    return context;
  };
  const selection = input.action === "query" ? null : { expectedAudioRevision: input.expectedAudioRevision, sources: input.sources,
    ...(input.requestVersion >= 2 ? { strategy: input.strategy } : {}) };
  const result = await broker.request(selection, authorize, signal, input.requestVersion);
  const previous = observedContext, checkedAt = clock();
  if (signal?.aborted || !sameNativeAudioContext(previous, authorize(checkedAt))) fail("native_audio_authority_changed");
  const common = { audioControlVersion: result.version, programId, programRevision: observedContext.programRevision, programEpoch: result.programEpoch,
    packagerId: observedContext.packagerId, assignmentId: result.assignmentId, fencingRevision: result.fencingRevision };
  // No writer lease, wire command ID, membership authority or audio payload leaves this projection.
  if (result.type === "source-program-audio-state") return Object.freeze({ ...common, outcome: "observed", observedAt: result.observedAt,
    audioRevision: result.audioRevision, sources: result.sources, ...(result.version >= 2 ? { mix: result.mix, encoding: result.encoding } : {}) });
  if (result.type === "source-program-audio-applied") {
    observeNativeDirectorApply(runtime, identity, observedContext, "audio-applied", result.audioRevision, checkedAt);
    return Object.freeze({ ...common, outcome: "applied", appliedAt: result.appliedAt, audioRevision: result.audioRevision });
  }
  observeNativeDirectorReject(runtime, identity, observedContext, "audio-rejected", checkedAt);
  return Object.freeze({ ...common, outcome: "rejected", observedAt: result.observedAt, reasonCode: result.reasonCode });
}
