import { BROADCAST_PROGRAM_STATES } from "./broadcast-program-model.js";

const MAX_EVENTS = 256, MAX_VISIBLE = 32, RETENTION_MS = 15 * 60 * 1000;
const kinds = new Set(["registered", "state-changed", "standby-changed", "handoff-begun", "handoff-assigned", "handoff-stopped"]);
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
  list(tenantId, programId, now) {
    if (!this.#time(now)) return null;
    const key = `${tenantId}\0${programId}`;
    return Object.freeze(this.#events.filter(e => e.key === key).slice(-MAX_VISIBLE).reverse()
      .map(({ key: _key, ...event }) => Object.freeze(event)));
  }
  destroy() { this.#closed = true; this.#events = []; }
}

export const BROADCAST_PROGRAM_HISTORY_KINDS = Object.freeze([...kinds]);
