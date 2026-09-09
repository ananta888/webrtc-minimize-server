import { randomBytes } from "node:crypto";

export class MachineLeaseError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new MachineLeaseError(code, status); };
const bindingKeys = ["issuer", "subject", "roomId", "taskId", "tenantId", "projectId",
  "protocolVersion", "runtimeId", "hubSessionId", "capabilitySet"];
const sameBinding = (a, b) => bindingKeys.every(key => typeof a?.[key] === "string" && a[key] === b?.[key]);
const taskOwnerKeys = ["issuer", "tenantId", "projectId", "taskId"];
const sameV2Task = (a, b) => a.protocolVersion === "v2" && b.protocolVersion === "v2"
  && taskOwnerKeys.every(key => a[key] === b[key]);

/** Ephemeral session ownership, not Hub authority. Every renewal needs a newly
 * verified Hub grant AND device proof. No membership or receive-right expansion. */
export class MachineSessionLeases {
  #records = new Map(); #clock; #maxSessions;
  constructor({ clock = Date.now, maxSessions = 1000 } = {}) {
    if (typeof clock !== "function" || !Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 10_000) {
      fail("machine_lease_config_invalid", 500);
    }
    this.#clock = clock; this.#maxSessions = maxSessions;
  }
  #view(record) {
    return Object.freeze({ schema: "ananta.meet-session-lease.v1", sessionId: record.id,
      generation: record.generation, expiresAt: record.expiresAt, absoluteExpiresAt: record.absoluteExpiresAt });
  }
  #arm(record) {
    clearTimeout(record.timer);
    const deadline = record.member ? record.expiresAt : Math.min(record.expiresAt, record.createdAt + 30_000);
    record.timer = setTimeout(() => this.close(record.id, "machine_session_expired"), Math.max(1, deadline - this.#clock()));
    record.timer.unref?.();
  }
  issue(identity, fingerprint) {
    const now = this.#clock(), binding = identity.machineBinding;
    if (!sameBinding(binding, binding) || typeof fingerprint !== "string" || !fingerprint
      || !Number.isSafeInteger(identity.machineExpiresAt) || identity.machineExpiresAt <= now
      || identity.machineExpiresAt > now + 600_000) fail("machine_lease_scope_invalid", 401);
    this.prune();
    if (this.#records.size >= this.#maxSessions) fail("machine_lease_capacity", 429);
    // Device proofs authenticate a holder; a different device is not authority
    // to run a second copy of the same Hub Task, even before either ticket joins.
    if ([...this.#records.values()].some(r => sameV2Task(r.binding, binding)
      || (sameBinding(r.binding, binding) && r.fingerprint === fingerprint))) {
      fail("machine_session_already_active");
    }
    const id = `ms_${randomBytes(24).toString("base64url")}`;
    const record = { id, binding: Object.freeze({ ...binding }), fingerprint, createdAt: now, lastNow: now,
      expiresAt: identity.machineExpiresAt, absoluteExpiresAt: now + 7_200_000, generation: 1,
      member: null, stop: null, timer: null };
    this.#records.set(id, record); this.#arm(record);
    return this.#view(record);
  }
  attach(id, member, stop, authorization = null, observation = null) {
    const record = this.#records.get(id);
    if (!record || record.member || typeof member !== "function" || typeof stop !== "function"
      || !this.live(id) || this.#clock() >= record.createdAt + 30_000) fail("machine_session_unavailable", 401);
    if ([authorization, observation].some(port => port !== null && typeof port !== "function")) {
      fail("machine_session_unavailable", 401);
    }
    record.member = member; record.stop = stop; record.authorization = authorization;
    record.observation = observation; this.#arm(record);
  }
  authorization(id, identity, nonce) {
    return this.#inspect(id, identity, nonce, "authorization", "ananta.meet-authorization.v1");
  }
  observation(id, identity, nonce) {
    return this.#inspect(id, identity, nonce, "observation", "ananta.meet-session-observation.v1");
  }
  #inspect(id, identity, nonce, port, schema) {
    if (!this.live(id)) fail("machine_session_unavailable", 401);
    const record = this.#records.get(id);
    if (!sameBinding(record.binding, identity.machineBinding) || record.binding.protocolVersion !== "v2"
      || !record[port] || typeof nonce !== "string" || !/^[a-f0-9]{32}$/.test(nonce)) fail("machine_lease_scope_invalid", 401);
    const state = record[port]();
    if (!this.live(id)) fail("machine_session_unavailable", 401);
    return Object.freeze({ schema, nonce,
      lease: this.#view(record), binding: Object.freeze({ ...record.binding }), ...state });
  }
  live(id) {
    const r = this.#records.get(id), now = this.#clock();
    if (!r) return false;
    let member = true;
    try { member = !r.member || r.member() === true; } catch { member = false; }
    if (now < r.lastNow || now >= r.expiresAt || !member) { this.close(id, "machine_session_expired"); return false; }
    r.lastNow = now; return true;
  }
  renew(id, expectedGeneration, identity, fingerprint) {
    if (!this.live(id)) fail("machine_session_unavailable", 401);
    const r = this.#records.get(id), now = this.#clock();
    if (!r.member || !sameBinding(r.binding, identity.machineBinding) || r.fingerprint !== fingerprint) {
      fail("machine_lease_scope_invalid", 401);
    }
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration !== r.generation || r.generation >= 512) {
      fail("machine_lease_generation_conflict");
    }
    const expiresAt = identity.machineExpiresAt;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= r.expiresAt || expiresAt > now + 600_000
      || expiresAt > r.absoluteExpiresAt) fail("machine_lease_deadline_invalid");
    r.expiresAt = expiresAt; ++r.generation; this.#arm(r);
    return this.#view(r);
  }
  close(id, reason = "machine_session_closed") {
    const r = this.#records.get(id);
    if (!r) return;
    this.#records.delete(id); clearTimeout(r.timer);
    try { r.stop?.(reason); } catch { /* Deleted authority remains revoked. */ }
  }
  prune() {
    for (const [id, r] of this.#records) {
      if (!r.member && this.#clock() >= r.createdAt + 30_000) this.close(id);
      else this.live(id);
    }
  }
  destroy() { for (const id of this.#records.keys()) this.close(id); }
}
