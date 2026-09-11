import type { PlaybackCapacityScope } from "./playback-capacity";

export const PROGRAM_HISTORY_STATES = ["draft", "preparing", "awaiting_consent", "publishing", "live", "degraded", "stopping", "stopped", "failed"] as const;
export const PROGRAM_HISTORY_KINDS = ["registered", "state-changed", "standby-changed", "handoff-begun", "handoff-assigned", "handoff-stopped"] as const;
export interface ProgramHistoryEvent {
  kind: typeof PROGRAM_HISTORY_KINDS[number]; state: typeof PROGRAM_HISTORY_STATES[number];
  programRevision: number; programEpoch: number; occurredAt: number; standbyCount: number;
}
export interface ProgramHistory extends PlaybackCapacityScope {
  version: 1; complete: false; retentionMs: 900000; observedAt: number; expiresAt: number;
  events: readonly ProgramHistoryEvent[];
}
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const exact = (v: unknown, fields: readonly string[]) => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === fields.length && Object.keys(v).every(k => fields.includes(k));
export function parseProgramHistory(value: unknown, before: PlaybackCapacityScope): ProgramHistory {
  const v = value as ProgramHistory;
  const fields = ["version", "complete", "retentionMs", "programId", "programRevision", "programEpoch", "observedAt", "expiresAt", "events"];
  if (!exact(v, fields) || v.version !== 1 || v.complete !== false || v.retentionMs !== 900000
    || typeof v.programId !== "string" || !/^prg_[A-Za-z0-9_-]{16,64}$/.test(v.programId) || v.programId !== before.programId
    || !positive(v.programRevision) || v.programRevision < before.programRevision || !positive(v.programEpoch) || v.programEpoch < before.programEpoch
    || !positive(v.observedAt) || !positive(v.expiresAt) || v.expiresAt <= v.observedAt || v.expiresAt - v.observedAt > 5000
    || !Array.isArray(v.events) || v.events.length > 32) throw new Error("invalid_program_history_response");
  let last = v.observedAt;
  for (const e of v.events) {
    if (!exact(e, ["kind", "state", "programRevision", "programEpoch", "occurredAt", "standbyCount"])
      || !PROGRAM_HISTORY_KINDS.includes(e.kind) || !PROGRAM_HISTORY_STATES.includes(e.state)
      || !positive(e.programRevision) || e.programRevision > v.programRevision || !positive(e.programEpoch) || e.programEpoch > v.programEpoch
      || !positive(e.occurredAt) || e.occurredAt > last || e.occurredAt <= v.observedAt - v.retentionMs
      || !Number.isSafeInteger(e.standbyCount) || e.standbyCount < 0 || e.standbyCount > 2) throw new Error("invalid_program_history_response");
    last = e.occurredAt;
  }
  return Object.freeze({ ...v, events: Object.freeze(v.events.map(e => Object.freeze({ ...e }))) });
}
