import { BroadcastPlaybackSessionError } from "./broadcast-playback-session-store.js";

const fail = (code, status = 409) => { throw new BroadcastPlaybackSessionError(code, status); };
const positive = n => Number.isSafeInteger(n) && n > 0;
export function normalizePlaybackObservation(value) {
  const fields = ["requestVersion", "deviceFingerprint", "expectedProgramRevision", "expectedProgramEpoch", "additionalSessions"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length
    || Object.keys(value).some(k => !fields.includes(k)) || value.requestVersion !== 1
    || typeof value.deviceFingerprint !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceFingerprint)
    || !positive(value.expectedProgramRevision) || !positive(value.expectedProgramEpoch)
    || !positive(value.additionalSessions) || value.additionalSessions > 10000) fail("invalid_playback_capacity_request", 400);
  return Object.freeze({ ...value });
}

/** Read-only current-owner projection. No grants, reservations or viewer identities. */
export class BroadcastPlaybackObservation {
  #budgets = new WeakMap();
  #closed = false;
  constructor({ clock = Date.now } = {}) { this.clock = clock; }
  query({ input: raw, identity, ownerPrincipal, programId, getMember, runtime, sessions }) {
    if (this.#closed || !runtime || !sessions) fail("playback_capacity_unavailable", 503);
    const input = normalizePlaybackObservation(raw), member = getMember(), now = this.clock();
    if (!positive(now) || !positive(identity?.expiresAt) || identity.expiresAt <= now
      || !member || member.machine || member.authenticated !== true || member.creator !== true || member.principal !== ownerPrincipal
      || member.deviceFingerprint !== input.deviceFingerprint) fail("playback_capacity_owner_required", 403);
    const budget = this.#budgets.get(member);
    if (budget && now < budget.last) fail("playback_capacity_clock_invalid");
    if (budget && now - budget.start < 60000) {
      budget.last = now;
      if (budget.count >= 12) fail("playback_capacity_rate_limited", 429);
      budget.count++;
    } else this.#budgets.set(member, { start: now, last: now, count: 1 });
    // Runtime verifies exact tenant, owner, room, peer, device and publisher binding.
    const writer = runtime.nativeSourceWriterContext(identity, member, programId, now);
    if (!writer || !["live", "degraded"].includes(writer.state)
      || writer.programRevision !== input.expectedProgramRevision || writer.programEpoch !== input.expectedProgramEpoch
      || !positive(writer.expiresAt) || writer.expiresAt <= now) fail("playback_capacity_scope_changed");
    const capacity = sessions.inspectProgramCapacity({ tenantId: writer.tenantId, programId,
      additionalSessions: input.additionalSessions, now });
    return Object.freeze({ version: 1, programId, programRevision: writer.programRevision, programEpoch: writer.programEpoch,
      observedAt: now, expiresAt: Math.min(now + 5000, writer.expiresAt, identity.expiresAt), reserved: false, ...capacity });
  }
  destroy() { this.#closed = true; this.#budgets = new WeakMap(); }
}
