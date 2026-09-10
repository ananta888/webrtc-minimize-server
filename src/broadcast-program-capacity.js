import { BROADCAST_ADMISSION_DEFAULTS } from "./broadcast-admission-control.js";

export const BROADCAST_PROGRAM_CAPACITY_DEFAULTS = Object.freeze({
  deployment: BROADCAST_ADMISSION_DEFAULTS.maxActiveProgramsDeployment,
  gateway: BROADCAST_ADMISSION_DEFAULTS.maxActiveProgramsGateway,
  tenant: BROADCAST_ADMISSION_DEFAULTS.maxActiveProgramsTenant,
  principal: BROADCAST_ADMISSION_DEFAULTS.maxActiveProgramsPrincipal,
});
const KEYS = Object.keys(BROADCAST_PROGRAM_CAPACITY_DEFAULTS);

export function normalizeBroadcastProgramCapacity(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !KEYS.includes(key))) throw new TypeError("invalid_broadcast_program_capacity");
  const result = { ...BROADCAST_PROGRAM_CAPACITY_DEFAULTS, ...value };
  if (Object.values(result).some(limit => !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)) {
    throw new TypeError("invalid_broadcast_program_capacity");
  }
  return Object.freeze(result);
}

function validScope(scope) {
  return scope && typeof scope === "object" && !Array.isArray(scope)
    && Object.keys(scope).length === 3
    && Object.keys(scope).every(key => ["tenantId", "principalRef", "programId"].includes(key))
    && [scope.tenantId, scope.principalRef, scope.programId].every(value => typeof value === "string")
    && /^tn_[A-Za-z0-9_-]{16,64}$/.test(scope.tenantId || "")
    && /^sub_[A-Za-z0-9_-]{16,64}$/.test(scope.principalRef || "")
    && /^prg_[A-Za-z0-9_-]{16,64}$/.test(scope.programId || "");
}

// Logical program admission only. Authoritative occupancy stays in the runtime,
// including pending starts. No shadow leases, media budgets or room ownership.
// The current composition root owns one gateway; deployment/gateway counts thus
// cover the same local inventory, not a distributed multi-process quota.
export class BroadcastProgramCapacity {
  #limits;
  constructor(limits) { this.#limits = normalizeBroadcastProgramCapacity(limits); }

  allows(candidate, occupied) {
    if (!validScope(candidate) || !Array.isArray(occupied) || occupied.length > 20_000) return false;
    const programs = new Map();
    for (const scope of [...occupied, candidate]) {
      if (!validScope(scope)) return false;
      const key = `${scope.tenantId}\0${scope.programId}`;
      const prior = programs.get(key);
      if (prior && prior.principalRef !== scope.principalRef) return false;
      programs.set(key, scope);
    }
    let tenant = 0, principal = 0;
    for (const scope of programs.values()) {
      if (scope.tenantId === candidate.tenantId) {
        tenant++;
        if (scope.principalRef === candidate.principalRef) principal++;
      }
    }
    return programs.size <= this.#limits.deployment && programs.size <= this.#limits.gateway
      && tenant <= this.#limits.tenant && principal <= this.#limits.principal;
  }
}
