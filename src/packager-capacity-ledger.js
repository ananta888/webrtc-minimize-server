const RESERVATION = /^rsv_[A-Za-z0-9_-]{16,64}$/;

export class PackagerCapacityError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "PackagerCapacityError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) { throw new PackagerCapacityError(code, status); }

function assertAdmission(admission) {
  if (!admission || admission.admissionVersion !== 1 || !Array.isArray(admission.renditions)
    || admission.renditions.length < 1 || admission.renditions.length > 3
    || !Number.isSafeInteger(admission.programEpoch) || admission.programEpoch < 1
    || typeof admission.programId !== "string" || typeof admission.agentId !== "string") {
    fail("invalid_packager_admission");
  }
}

export function estimatePackagerDemand(admission) {
  assertAdmission(admission);
  const pixelsPerSecond = admission.renditions.reduce(
    (sum, rendition) => sum + rendition.width * rendition.height * rendition.framesPerSecond,
    0,
  );
  const hardware = admission.videoEncoder !== admission.softwareFallback;
  return Object.freeze({
    cpuUnits: Math.max(1, Math.ceil((pixelsPerSecond / 1_000_000) * (hardware ? 0.35 : 1))),
    memoryMiB: 128 + 96 * admission.renditions.length,
    encoderSlots: admission.renditions.length,
    gpuSlots: hardware ? admission.renditions.length : 0,
    egressBitsPerSecond: Math.ceil(admission.renditions.reduce(
      (sum, rendition) => sum + rendition.videoBitsPerSecond + rendition.audioBitsPerSecond,
      0,
    ) * 1.15),
  });
}

function normalizeCapacity(capacity) {
  const names = ["cpuUnits", "memoryMiB", "encoderSlots", "gpuSlots", "egressBitsPerSecond"];
  if (!capacity || typeof capacity !== "object" || Array.isArray(capacity)
    || Object.keys(capacity).length !== names.length || names.some((name) => (
      !Number.isSafeInteger(capacity[name]) || capacity[name] < 0
    ))) fail("invalid_packager_capacity");
  return Object.freeze({ ...capacity });
}

function fits(used, demand, capacity) {
  return Object.keys(capacity).every((name) => used[name] + demand[name] <= capacity[name]);
}

function admissionWithRenditionCount(admission, count) {
  return Object.freeze({ ...admission, renditions: Object.freeze(admission.renditions.slice(0, count)) });
}

export class PackagerCapacityLedger {
  #capacity;
  #reservations = new Map();

  constructor(capacity) {
    this.#capacity = normalizeCapacity(capacity);
  }

  #prune(now) {
    for (const [id, value] of this.#reservations) {
      if (value.expiresAt <= now) this.#reservations.delete(id);
    }
  }

  #used() {
    const used = { cpuUnits: 0, memoryMiB: 0, encoderSlots: 0, gpuSlots: 0, egressBitsPerSecond: 0 };
    for (const { demand } of this.#reservations.values()) {
      for (const name of Object.keys(used)) used[name] += demand[name];
    }
    return used;
  }

  reserveBestEffort(admission, { reservationId, now = Date.now(), expiresAt }) {
    assertAdmission(admission);
    if (!RESERVATION.test(reservationId || "") || !Number.isSafeInteger(now)
      || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 300_000) {
      fail("invalid_packager_reservation");
    }
    this.#prune(now);
    const requestKey = JSON.stringify(admission);
    const existing = this.#reservations.get(reservationId);
    if (existing) {
      if (existing.requestKey !== requestKey) {
        fail("packager_reservation_conflict", 409);
      }
      return existing.publicValue;
    }
    const used = this.#used();
    for (let count = admission.renditions.length; count >= 1; count -= 1) {
      const selectedAdmission = admissionWithRenditionCount(admission, count);
      const demand = estimatePackagerDemand(selectedAdmission);
      if (!fits(used, demand, this.#capacity)) continue;
      const publicValue = Object.freeze({
        reservationId,
        programId: admission.programId,
        programEpoch: admission.programEpoch,
        agentId: admission.agentId,
        expiresAt,
        demand,
        admission: selectedAdmission,
        degraded: count < admission.renditions.length,
      });
      this.#reservations.set(reservationId, { ...publicValue, requestKey, publicValue });
      return publicValue;
    }
    fail("packager_capacity_exhausted", 503);
  }

  release({ reservationId, programId, programEpoch }, now = Date.now()) {
    this.#prune(now);
    const existing = this.#reservations.get(reservationId);
    if (!existing) return false;
    if (existing.programId !== programId || existing.programEpoch !== programEpoch) {
      fail("packager_reservation_fence_mismatch", 409);
    }
    this.#reservations.delete(reservationId);
    return true;
  }

  snapshot(now = Date.now()) {
    this.#prune(now);
    return Object.freeze({
      capacity: this.#capacity,
      used: Object.freeze(this.#used()),
      activeReservations: this.#reservations.size,
    });
  }
}
