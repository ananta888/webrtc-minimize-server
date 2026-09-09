export interface NativeAudioLevel {
  readonly sourceLeaseId: string; readonly leftGainQ15: number; readonly rightGainQ15: number; readonly muted: boolean;
}
export interface NativeAudioSelection { readonly expectedAudioRevision: number; readonly sources: readonly NativeAudioLevel[] }
interface AudioScope {
  readonly audioControlVersion: 1; readonly programId: string; readonly programRevision: number; readonly programEpoch: number;
  readonly packagerId: string; readonly assignmentId: string; readonly fencingRevision: number;
}
export interface NativeAudioState extends AudioScope {
  readonly outcome: "observed"; readonly observedAt: number; readonly audioRevision: number;
  readonly sources: readonly (NativeAudioLevel & { readonly sourceKind: "microphone" | "screen-audio" })[];
}
export type NativeAudioResult = NativeAudioState
  | (AudioScope & { readonly outcome: "applied"; readonly appliedAt: number; readonly audioRevision: number })
  | (AudioScope & { readonly outcome: "rejected"; readonly observedAt: number; readonly reasonCode: "AUDIO_NOT_APPLIED" });
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const ref = (v: unknown, prefix: string): v is string => typeof v === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`).test(v);
const closed = (v: any, keys: string[]): boolean => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const gain = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 32768;
function validSources(v: any, observed: boolean): boolean {
  const keys = ["sourceLeaseId", "leftGainQ15", "rightGainQ15", "muted", ...(observed ? ["sourceKind"] : [])];
  return Array.isArray(v) && v.length <= 80 && (observed || v.length > 0)
    && v.every(s => closed(s, keys) && ref(s.sourceLeaseId, "sls") && gain(s.leftGainQ15) && gain(s.rightGainQ15)
      && typeof s.muted === "boolean" && (!observed || ["microphone", "screen-audio"].includes(s.sourceKind)))
    && new Set(v.map(s => s.sourceLeaseId)).size === v.length;
}
export function validAudioSelection(value: NativeAudioSelection): boolean {
  return closed(value, ["expectedAudioRevision", "sources"]) && positive(value.expectedAudioRevision)
    && value.expectedAudioRevision < Number.MAX_SAFE_INTEGER && validSources(value.sources, false);
}
export function parseNativeAudioResult(raw: unknown, program: { programId: string; programRevision: number; programEpoch: number }, now = Date.now()): NativeAudioResult {
  const v = raw as any, fail = (): never => { throw new Error("invalid_native_audio_response"); };
  const fields = ["audioControlVersion", "programId", "programRevision", "programEpoch", "packagerId", "assignmentId", "fencingRevision", "outcome"];
  if (v?.outcome === "observed") fields.push("observedAt", "audioRevision", "sources");
  else if (v?.outcome === "applied") fields.push("appliedAt", "audioRevision");
  else if (v?.outcome === "rejected") fields.push("observedAt", "reasonCode");
  else fail();
  if (!closed(v, fields) || v.audioControlVersion !== 1 || !ref(v.programId, "prg") || v.programId !== program.programId
    || !positive(v.programRevision) || v.programRevision !== program.programRevision || !positive(v.programEpoch) || v.programEpoch !== program.programEpoch
    || !ref(v.packagerId, "pkr") || !ref(v.assignmentId, "asn") || !positive(v.fencingRevision)) fail();
  const at = v.outcome === "applied" ? v.appliedAt : v.observedAt;
  if (!positive(now) || !positive(at) || at > now + 1000 || at <= now - 5000) fail();
  if (v.outcome === "rejected" && v.reasonCode !== "AUDIO_NOT_APPLIED") fail();
  if (v.outcome === "applied" && (!positive(v.audioRevision) || v.audioRevision < 2)) fail();
  if (v.outcome === "observed" && (!positive(v.audioRevision) || !validSources(v.sources, true))) fail();
  return Object.freeze({ ...v, ...(v.outcome === "observed" ? { sources: Object.freeze(v.sources.map((s: NativeAudioLevel) => Object.freeze({ ...s }))) } : {}) });
}
