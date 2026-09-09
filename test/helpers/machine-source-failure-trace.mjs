// Private fixture only. No production hook or exception suppression. Native
// Error instances, arguments, prototype and thrown values are preserved.
export function installMachineSourceFailureTrace() {
  window.__machineSourceFailureTrace?.close();
  const Original = window.Error, started = performance.now(), events = [];
  const codes = new Set([
    "meet_avatar_source_denied", "meet_avatar_authority_expired", "meet_avatar_generation_changed",
    "meet_avatar_setup_timeout", "meet_avatar_protection_lost", "meet_avatar_not_ready",
    "meet_avatar_video_decoder_failed", "meet_avatar_video_metadata_invalid", "meet_avatar_video_decode_expired",
    "meet_avatar_video_failed", "meet_avatar_video_not_ready", "meet_avatar_video_digest_invalid",
    "meet_avatar_video_timing_unsupported", "meet_video_frame_clock_failed",
    "meet_media_timing_observation_invalid", "meet_media_timing_position_invalid", "meet_media_timing_stale",
    "meet_media_timing_drift_exceeded", "meet_media_timing_clock_invalid", "meet_media_timing_membership_changed",
    "meet_media_timing_source_failed", "meet_media_timing_closed", "meet_media_timing_disabled_or_failed",
    "meet_speech_source_denied", "meet_speech_authority_changed", "meet_speech_setup_timeout",
    "meet_speech_setup_cancelled", "meet_speech_closed", "meet_speech_frame_stale", "meet_speech_frame_order_invalid",
    "meet_speech_buffer_exceeded", "meet_speech_graph_failed", "meet_speech_expired", "meet_speech_context_unavailable",
  ]);
  const causes = new Set(["inactive", "clock-invalid", "clock-backwards", "activation-expired", "controller-expired",
    "source-id", "session-id", "lease-generation", "membership-epoch", "lease-expiry", "authority-unavailable",
    "progress-expired", "sourceId", "sessionId", "leaseGeneration", "membershipEpoch", "expiresAt", "scope"]);
  let closed = false, truncated = false;
  const record = (args, value) => {
    if (closed || typeof args[0] !== "string" || !codes.has(args[0])) return;
    if (events.length === 64) { truncated = true; return; }
    const elapsed = Math.floor(performance.now() - started);
    const cause = Object.getOwnPropertyDescriptor(value, "cause")?.value;
    events.push({ code: args[0], ...(typeof cause === "string" && causes.has(cause) ? { cause } : {}),
      elapsedMs: Number.isSafeInteger(elapsed) && elapsed >= 0 && elapsed <= 120000 ? elapsed : null });
  };
  const Wrapped = new Proxy(Original, {
    construct(target, args, newTarget) { const value = Reflect.construct(target, args, newTarget); record(args, value); return value; },
    apply(target, receiver, args) { const value = Reflect.apply(target, receiver, args); record(args, value); return value; },
  });
  window.Error = Wrapped;
  window.__machineSourceFailureTrace = Object.freeze({
    snapshot: () => ({ events: events.map(event => ({ ...event })), truncated }),
    close: () => { closed = true; if (window.Error === Wrapped) window.Error = Original; },
  });
}
