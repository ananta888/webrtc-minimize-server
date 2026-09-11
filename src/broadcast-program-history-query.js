import { BroadcastPlaybackSessionError } from "./broadcast-playback-session-store.js";

const fail = (code, status) => { throw new BroadcastPlaybackSessionError(code, status); };
export function normalizeProgramHistoryQuery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2
    || Object.keys(value).some(k => !["requestVersion", "deviceFingerprint"].includes(k)) || ![1, 2, 3].includes(value.requestVersion)
    || typeof value.deviceFingerprint !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceFingerprint)) {
    fail("invalid_program_history_request", 400);
  }
  return Object.freeze({ ...value });
}

export class BroadcastProgramHistoryQuery {
  #budgets = new WeakMap();
  #closed = false;
  constructor({ clock = Date.now } = {}) { this.clock = clock; }
  query({ input: raw, identity, ownerPrincipal, programId, getMember, runtime }) {
    if (this.#closed || !runtime) fail("program_history_unavailable", 503);
    const input = normalizeProgramHistoryQuery(raw), member = getMember(), now = this.clock();
    if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(identity?.expiresAt) || identity.expiresAt <= now
      || !member || member.machine || member.authenticated !== true || member.creator !== true
      || member.principal !== ownerPrincipal || member.deviceFingerprint !== input.deviceFingerprint) fail("program_history_owner_required", 403);
    const budget = this.#budgets.get(member);
    if (budget && now < budget.last) fail("program_history_unavailable", 503);
    if (budget && now - budget.start < 60000) {
      budget.last = now;
      if (budget.count >= 12) fail("program_history_rate_limited", 429);
      budget.count++;
    } else this.#budgets.set(member, { start: now, last: now, count: 1 });
    const result = runtime.nativeProgramHistory(identity, member, programId, now, input.requestVersion);
    return Object.freeze({ version: input.requestVersion, ...result, observedAt: now, expiresAt: Math.min(now + 5000, identity.expiresAt),
      complete: false, retentionMs: 900000 });
  }
  destroy() { this.#closed = true; this.#budgets = new WeakMap(); }
}
