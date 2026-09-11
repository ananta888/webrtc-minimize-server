import { BROADCAST_PROGRAM_STATES } from "./broadcast-program-model.js";

const MAX_SAMPLES = 256, RETENTION_MS = 15 * 60 * 1000, MAX_DURATION_MS = 60 * 60 * 1000;
export const BROADCAST_TRANSITIONS = Object.freeze(["start", "stop", "handoff"]);
const positive = n => Number.isSafeInteger(n) && n > 0;
function projection(record) {
  const machine = record?.snapshot?.machine, p = machine?.program, scope = machine?.scope;
  if (!p || !scope || typeof scope.tenantId !== "string" || typeof scope.programId !== "string"
    || !positive(p.programEpoch) || !BROADCAST_PROGRAM_STATES.includes(p.state)) return null;
  return { key: `${scope.tenantId}\0${scope.programId}`, state: p.state, epoch: p.programEpoch, pending: Boolean(record.pendingHandoff) };
}

/** Content-free transition durations for the metrics sampler: no identifiers, no policy, bounded window. */
export class BroadcastProgramTransitions {
  #anchors = new Map();
  #samples = [];
  #lastNow = 0;
  #closed = false;
  #time(now) {
    if (this.#closed || !positive(now) || now < this.#lastNow) { this.#anchors.clear(); this.#samples = []; return false; }
    this.#lastNow = now;
    this.#samples = this.#samples.filter(s => s.observedAt > now - RETENTION_MS);
    return true;
  }
  #record(transition, startedAt, now) {
    const ms = now - startedAt;
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_DURATION_MS) return;
    this.#samples.push(Object.freeze({ transition, seconds: ms / 1000, observedAt: now }));
    if (this.#samples.length > MAX_SAMPLES) this.#samples.splice(0, this.#samples.length - MAX_SAMPLES);
  }
  observe(before, after, now) {
    if (!this.#time(now)) return false;
    const a = projection(before), b = projection(after);
    if (!b || before != null && !a || a && a.key !== b.key) return false;
    const anchor = this.#anchors.get(b.key) ?? { registeredAt: now, stoppingAt: null, handoff: null, started: false };
    if (!a) { this.#anchors.set(b.key, anchor); return true; }
    // A handoff restarts output under a new epoch; it is complete once that
    // successor epoch reports confirmed output. Start counts once per program.
    if (!a.pending && b.pending) anchor.handoff = { at: now, epoch: a.epoch };
    if (a.state !== "stopping" && b.state === "stopping") anchor.stoppingAt = now;
    if (b.state === "live" && !anchor.started) { anchor.started = true; this.#record("start", anchor.registeredAt, now); }
    else if (b.state === "live" && anchor.handoff && !b.pending && b.epoch > anchor.handoff.epoch) {
      this.#record("handoff", anchor.handoff.at, now); anchor.handoff = null;
    }
    if (b.state === "stopped" && a.state !== "stopped") {
      if (anchor.stoppingAt !== null) this.#record("stop", anchor.stoppingAt, now);
      this.#anchors.delete(b.key);
    } else if (b.state === "failed" && a.state !== "failed") this.#anchors.delete(b.key);
    else this.#anchors.set(b.key, anchor);
    return true;
  }
  /** Windowed observations for the pull sampler; never program-specific. */
  samples(now) {
    if (!this.#time(now)) return null;
    return Object.freeze(this.#samples.map(({ transition, seconds }) => Object.freeze({ transition, seconds })));
  }
  get pendingPrograms() { return this.#anchors.size; }
  prune(now) { return this.#time(now); }
  destroy() { this.#closed = true; this.#anchors.clear(); this.#samples = []; }
}
