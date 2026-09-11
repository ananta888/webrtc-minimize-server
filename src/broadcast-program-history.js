import { BROADCAST_PROGRAM_STATES } from "./broadcast-program-model.js";

const MAX_EVENTS = 256, MAX_VISIBLE = 32, RETENTION_MS = 15 * 60 * 1000;
const kinds = new Set(["registered", "state-changed", "standby-changed", "handoff-begun", "handoff-assigned", "handoff-stopped"]);
const actions = new Set(["source-consented", "source-revoked", "scene-applied", "audio-applied"]);
// v3: invitations and agent-rejected commands. Expiry of an unanswered invitation is
// not journaled: the invitation record outlives its consent unchanged until TTL.
const requests = new Set(["source-requested", "source-request-closed", "scene-rejected", "audio-rejected"]);
const reasons = new Set(["user-revoked", "program-owner-removed", "expired", "lease-lost", "destroyed"]);
const requestReasons = Object.freeze({ "source-requested": new Set(["own-source", "invited"]),
  "source-request-closed": new Set(["declined", "cancelled", "invalidated"]) });
const SOURCE_KINDS = ["camera", "microphone", "screen", "screen-audio"];
const visible = Object.freeze({ 1: kinds, 2: new Set([...kinds, ...actions]), 3: new Set([...kinds, ...actions, ...requests]) });
const positive = n => Number.isSafeInteger(n) && n > 0;
function projection(record) {
  const machine = record?.snapshot?.machine, p = machine?.program, scope = machine?.scope;
  if (!p || !scope || !/^tn_[A-Za-z0-9_-]{16,64}$/.test(scope.tenantId || "")
    || !/^prg_[A-Za-z0-9_-]{16,64}$/.test(scope.programId || "") || !positive(p.revision)
    || !positive(p.programEpoch) || !BROADCAST_PROGRAM_STATES.includes(p.state)) return null;
  return { key: `${scope.tenantId}\0${scope.programId}`, programRevision: p.revision, programEpoch: p.programEpoch,
    state: p.state, pending: Boolean(record.pendingHandoff), standbyRevision: record.standbyPlan?.revision ?? 0,
    standbyCount: record.standbyPlan?.packagerIds?.length ?? 0 };
}

/** Best-effort, bounded, process-local metadata; never participates in policy decisions. */
export class BroadcastProgramHistory {
  #events = [];
  #lastNow = 0;
  #closed = false;
  #time(now) {
    if (this.#closed || !positive(now) || now < this.#lastNow) { this.#events = []; return false; }
    this.#lastNow = now;
    this.#events = this.#events.filter(e => e.occurredAt > now - RETENTION_MS);
    return true;
  }
  observe(before, after, now) {
    if (!this.#time(now)) return false;
    const a = projection(before), b = projection(after);
    if (!b || before != null && !a || a && a.key !== b.key || !Number.isSafeInteger(b.standbyCount)
      || b.standbyCount < 0 || b.standbyCount > 2) return false;
    const events = [];
    if (!a) events.push("registered");
    else {
      if (a.state !== b.state) events.push("state-changed");
      if (!a.pending && b.pending) events.push("handoff-begun");
      if (a.pending && !b.pending) events.push(b.state === "stopped" ? "handoff-stopped" : "handoff-assigned");
      if (a.standbyRevision !== b.standbyRevision) events.push("standby-changed");
    }
    for (const kind of events) this.#events.push(Object.freeze({ key: b.key, kind, occurredAt: now,
      programRevision: b.programRevision, programEpoch: b.programEpoch, state: b.state, standbyCount: b.standbyCount }));
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
    return true;
  }
  action(record, event, now) {
    if (!this.#time(now)) return false;
    const p = projection(record);
    if (!p || !Number.isSafeInteger(p.standbyCount) || p.standbyCount < 0 || p.standbyCount > 2
      || !event || Object.keys(event).length !== 4
      || Object.keys(event).some(k => !["kind", "sourceKind", "reason", "controlRevision"].includes(k))
      || !actions.has(event.kind) && !requests.has(event.kind)) return false;
    const source = event.kind.startsWith("source-");
    if (source ? !SOURCE_KINDS.includes(event.sourceKind) || event.controlRevision !== null
      || (event.kind === "source-revoked" ? !reasons.has(event.reason)
        : event.kind in requestReasons ? !requestReasons[event.kind].has(event.reason) : event.reason !== null)
      : event.sourceKind !== null || event.reason !== null
        || (event.kind.endsWith("-rejected") ? event.controlRevision !== null : !positive(event.controlRevision))) return false;
    this.#events.push(Object.freeze({ key: p.key, ...event, occurredAt: now, programRevision: p.programRevision,
      programEpoch: p.programEpoch, state: p.state, standbyCount: p.standbyCount }));
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
    return true;
  }
  list(tenantId, programId, now, version = 1) {
    if (!this.#time(now)) return null;
    if (!Object.hasOwn(visible, version)) return null;
    const key = `${tenantId}\0${programId}`;
    return Object.freeze(this.#events.filter(e => e.key === key && visible[version].has(e.kind)).slice(-MAX_VISIBLE).reverse()
      .map(({ key: _key, ...event }) => Object.freeze(version === 1 ? event
        : { sourceKind: null, reason: null, controlRevision: null, ...event })));
  }
  destroy() { this.#closed = true; this.#events = []; }
  prune(now) { return this.#time(now); }
}

export const BROADCAST_PROGRAM_HISTORY_KINDS = Object.freeze([...kinds]);
