// Cookie-session admission, not unique humans, active viewers or network load.
// The session store owns occupancy; this policy never retains identities.
export const BROADCAST_PLAYBACK_CAPACITY_DEFAULTS = Object.freeze({
  deployment: 1024, tenant: 1024, program: 500, audience: 4,
});
export const BROADCAST_PLAYBACK_CAPACITY_ENV = Object.freeze({
  deployment: "BROADCAST_MAX_PLAYBACK_SESSIONS",
  tenant: "BROADCAST_MAX_PLAYBACK_SESSIONS_PER_TENANT",
  program: "BROADCAST_MAX_PLAYBACK_SESSIONS_PER_PROGRAM",
  audience: "BROADCAST_MAX_PLAYBACK_SESSIONS_PER_AUDIENCE",
});
const FIELDS = Object.keys(BROADCAST_PLAYBACK_CAPACITY_DEFAULTS);

export function normalizeBroadcastPlaybackCapacity(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !FIELDS.includes(key))) throw new TypeError("invalid_broadcast_playback_capacity");
  const result = { ...BROADCAST_PLAYBACK_CAPACITY_DEFAULTS, ...value };
  if (Object.values(result).some(limit => !Number.isSafeInteger(limit) || limit < 0 || limit > 10000)) {
    throw new TypeError("invalid_broadcast_playback_capacity");
  }
  return Object.freeze(result);
}

export function playbackCapacityScope(grant) {
  if (!grant || typeof grant.tenantId !== "string" || !/^tn_[A-Za-z0-9_-]{16,64}$/.test(grant.tenantId)
    || typeof grant.programId !== "string" || !/^prg_[A-Za-z0-9_-]{16,64}$/.test(grant.programId)
    || typeof grant.audienceRef !== "string" || !/^(sub|pkr)_[A-Za-z0-9_-]{16,64}$/.test(grant.audienceRef)) {
    throw new TypeError("invalid_broadcast_playback_scope");
  }
  return Object.freeze({ tenantId: grant.tenantId, programId: grant.programId, audienceRef: grant.audienceRef });
}

export class BroadcastPlaybackCapacity {
  #limits;
  constructor(limits) { this.#limits = normalizeBroadcastPlaybackCapacity(limits); }

  allows(candidate, occupied) {
    try {
      const scope = playbackCapacityScope(candidate);
      if (!Array.isArray(occupied) || occupied.length >= this.#limits.deployment) return false;
      let tenant = 1, program = 1, audience = 1;
      for (const record of occupied) {
        const other = playbackCapacityScope(record);
        // Audience limits remain global, matching the original session policy.
        if (other.audienceRef === scope.audienceRef) audience++;
        if (other.tenantId === scope.tenantId) {
          tenant++;
          if (other.programId === scope.programId) program++;
        }
      }
      return tenant <= this.#limits.tenant && program <= this.#limits.program && audience <= this.#limits.audience;
    } catch { return false; }
  }
}
