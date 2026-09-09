// Serialized into the already-owned test browser; read-only, no policy/capture.
export function beforeMachineLeaseExpiry(deadline) {
  if (Date.now() < deadline - 700) return false;
  const api = window.anantaMachine, status = api.status();
  return { joined: status.joined, open: api.screen.status().open,
    error: window.__leaseSource.error, e2ee: status.e2ee, observedAt: Date.now() };
}

export function isMachineLeaseObservation(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join() === "e2ee,error,joined,observedAt,open"
    && [value.error, value.joined, value.open].every(v => typeof v === "boolean")
    && typeof value.e2ee === "string" && Number.isSafeInteger(value.observedAt);
}

export function retiredMachineAvatar(expectedParticipants) {
  const api = window.anantaMachine, status = api.status();
  const avatar = api.avatar.status();
  return status.joined === true && status.peers === expectedParticipants
    && (avatar.state === "failed" || avatar.state === "closed");
}

// Fixed numeric/enum projection only; never serialize a source, exception or frame.
export function machineLeaseSupplyObservation(deadline) {
  const state = window.__leaseSource, api = window.anantaMachine;
  const bounded = (value, limit) => Number.isFinite(value) ? Math.max(-limit, Math.min(limit, Math.round(value))) : null;
  const reasons = ["inactive", "clock_rollback", "source_ended", "activation_expired", "frame_stalled",
    "scope_changed", "authority_unavailable", "decode_timeout", "decode_or_frame_failed", "decoder_busy", "closed"];
  const reason = api.screen.diagnostics().lastStopReason;
  return {
    suppliedFrames: bounded(state.sequence, 80), pushInFlight: state.pushInFlight === true,
    lastPushDurationMs: bounded(state.lastPushDurationMs, 45000),
    lastAcceptedBeforeExpiryMs: state.lastAccepted > 0 ? bounded(deadline - state.lastAccepted, 45000) : null,
    rejectedAfterExpiryMs: state.closedAt > 0 ? bounded(state.closedAt - deadline, 45000) : null,
    sourceStopReason: reasons.includes(reason) ? reason : "unknown",
  };
}
