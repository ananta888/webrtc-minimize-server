import type { BroadcastProgramRef } from "./broadcast-ports";

export type PlaybackCapacityScope = Pick<BroadcastProgramRef, "programId" | "programRevision" | "programEpoch">;
export interface PlaybackCapacity {
  version: 1; programId: string; programRevision: number; programEpoch: number;
  observedAt: number; expiresAt: number; reserved: false;
  programSessions: number; programLimit: number; perAudienceLimit: number;
  additionalSessions: number; sharedBudgetsFit: boolean;
}
export function parsePlaybackCapacity(value: unknown, scope: PlaybackCapacityScope, additional: number): PlaybackCapacity {
  const fields = ["version", "programId", "programRevision", "programEpoch", "observedAt", "expiresAt", "reserved",
    "programSessions", "programLimit", "perAudienceLimit", "additionalSessions", "sharedBudgetsFit"];
  const v = value as PlaybackCapacity;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== fields.length
    || Object.keys(v).some(k => !fields.includes(k)) || v.version !== 1 || v.reserved !== false
    || typeof v.programId !== "string" || !/^prg_[A-Za-z0-9_-]{16,64}$/.test(v.programId)
    || v.programId !== scope.programId || v.programRevision !== scope.programRevision || v.programEpoch !== scope.programEpoch
    || [v.programRevision, v.programEpoch, v.observedAt, v.expiresAt, v.additionalSessions].some(n => !Number.isSafeInteger(n) || n <= 0)
    || v.expiresAt <= v.observedAt || v.expiresAt - v.observedAt > 5000
    || [v.programSessions, v.programLimit, v.perAudienceLimit].some(n => !Number.isSafeInteger(n) || n < 0 || n > 10000)
    || v.additionalSessions !== additional || additional > 10000 || typeof v.sharedBudgetsFit !== "boolean"
    || v.sharedBudgetsFit && v.programSessions + additional > v.programLimit) throw new Error("invalid_playback_capacity_response");
  return Object.freeze({ ...v });
}
