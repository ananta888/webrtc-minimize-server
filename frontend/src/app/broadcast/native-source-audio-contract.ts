export interface NativeAudioLevel {
  readonly sourceLeaseId: string; readonly leftGainQ15: number; readonly rightGainQ15: number; readonly muted: boolean;
}
export const NATIVE_AUDIO_STRATEGIES = ["unprocessed", "balanced", "speech-first", "screen-first"] as const;
export type NativeAudioStrategy = typeof NATIVE_AUDIO_STRATEGIES[number];
export interface NativeAudioSelection { readonly expectedAudioRevision: number; readonly sources: readonly NativeAudioLevel[]; readonly strategy?: NativeAudioStrategy }
export interface NativeAudioMix {
  readonly strategy: NativeAudioStrategy; readonly microphoneGainQ15: number; readonly screenAudioGainQ15: number;
  readonly limiterGainQ15: number; readonly peakQ15: number;
}
export interface NativeAudioEncoding {
  readonly codec: "aac"; readonly sampleRate: 48000; readonly channels: 2;
  readonly renditions: readonly { readonly id: "low" | "medium" | "high"; readonly targetBitsPerSecond: number }[];
}
interface AudioScope {
  readonly audioControlVersion: 1 | 2; readonly programId: string; readonly programRevision: number; readonly programEpoch: number;
  readonly packagerId: string; readonly assignmentId: string; readonly fencingRevision: number;
}
interface NativeAudioObservation extends AudioScope {
  readonly outcome: "observed"; readonly observedAt: number; readonly audioRevision: number;
  readonly sources: readonly (NativeAudioLevel & { readonly sourceKind: "microphone" | "screen-audio" })[];
}
export type NativeAudioState = NativeAudioObservation & ({ readonly audioControlVersion: 1; readonly mix?: never; readonly encoding?: never }
  | { readonly audioControlVersion: 2; readonly mix: NativeAudioMix; readonly encoding: NativeAudioEncoding });
export type NativeAudioResult = NativeAudioState
  | (AudioScope & { readonly outcome: "applied"; readonly appliedAt: number; readonly audioRevision: number })
  | (AudioScope & { readonly outcome: "rejected"; readonly observedAt: number; readonly reasonCode: "AUDIO_NOT_APPLIED" });
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const ref = (v: unknown, prefix: string): v is string => typeof v === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`).test(v);
const closed = (v: any, keys: string[]): boolean => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const gain = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 32768;
function validSources(v: any, observed: boolean, allowEmpty = observed): boolean {
  const keys = ["sourceLeaseId", "leftGainQ15", "rightGainQ15", "muted", ...(observed ? ["sourceKind"] : [])];
  return Array.isArray(v) && v.length <= 80 && (allowEmpty || v.length > 0)
    && v.every(s => closed(s, keys) && ref(s.sourceLeaseId, "sls") && gain(s.leftGainQ15) && gain(s.rightGainQ15)
      && typeof s.muted === "boolean" && (!observed || ["microphone", "screen-audio"].includes(s.sourceKind)))
    && new Set(v.map(s => s.sourceLeaseId)).size === v.length;
}
export function validAudioSelection(value: NativeAudioSelection, version: 1 | 2 = 1): boolean {
  return [1, 2].includes(version) && closed(value, ["expectedAudioRevision", "sources", ...(version === 2 ? ["strategy"] : [])]) && positive(value.expectedAudioRevision)
    && value.expectedAudioRevision < Number.MAX_SAFE_INTEGER && validSources(value.sources, false, version === 2)
    && (version === 1 || NATIVE_AUDIO_STRATEGIES.includes(value.strategy as NativeAudioStrategy));
}
function validMix(v: any): boolean {
  return closed(v, ["strategy", "microphoneGainQ15", "screenAudioGainQ15", "limiterGainQ15", "peakQ15"])
    && NATIVE_AUDIO_STRATEGIES.includes(v.strategy)
    && [v.microphoneGainQ15, v.screenAudioGainQ15, v.limiterGainQ15, v.peakQ15].every(gain);
}
function validEncoding(v: any): boolean {
  return closed(v, ["codec", "sampleRate", "channels", "renditions"]) && v.codec === "aac" && v.sampleRate === 48000 && v.channels === 2
    && Array.isArray(v.renditions) && v.renditions.length > 0 && v.renditions.length <= 3
    && v.renditions.every((r: any) => closed(r, ["id", "targetBitsPerSecond"]) && ["low", "medium", "high"].includes(r.id)
      && Number.isSafeInteger(r.targetBitsPerSecond) && r.targetBitsPerSecond >= 16000 && r.targetBitsPerSecond <= 320000)
    && new Set(v.renditions.map((r: any) => r.id)).size === v.renditions.length;
}
export function parseNativeAudioResult(raw: unknown, program: { programId: string; programRevision: number; programEpoch: number }, now = Date.now(), version: 1 | 2 = 1): NativeAudioResult {
  const v = raw as any, fail = (): never => { throw new Error("invalid_native_audio_response"); };
  const fields = ["audioControlVersion", "programId", "programRevision", "programEpoch", "packagerId", "assignmentId", "fencingRevision", "outcome"];
  if (v?.outcome === "observed") fields.push("observedAt", "audioRevision", "sources");
  else if (v?.outcome === "applied") fields.push("appliedAt", "audioRevision");
  else if (v?.outcome === "rejected") fields.push("observedAt", "reasonCode");
  else fail();
  if (v?.outcome === "observed" && version === 2) fields.push("mix", "encoding");
  if (![1, 2].includes(version) || !closed(v, fields) || v.audioControlVersion !== version || !ref(v.programId, "prg") || v.programId !== program.programId
    || !positive(v.programRevision) || v.programRevision !== program.programRevision || !positive(v.programEpoch) || v.programEpoch !== program.programEpoch
    || !ref(v.packagerId, "pkr") || !ref(v.assignmentId, "asn") || !positive(v.fencingRevision)) fail();
  const at = v.outcome === "applied" ? v.appliedAt : v.observedAt;
  if (!positive(now) || !positive(at) || at > now + 1000 || at <= now - 5000) fail();
  if (v.outcome === "rejected" && v.reasonCode !== "AUDIO_NOT_APPLIED") fail();
  if (v.outcome === "applied" && (!positive(v.audioRevision) || v.audioRevision < 2)) fail();
  if (v.outcome === "observed" && (!positive(v.audioRevision) || !validSources(v.sources, true))) fail();
  if (v.outcome === "observed" && version === 2 && (!validMix(v.mix) || !validEncoding(v.encoding))) fail();
  return Object.freeze({ ...v, ...(v.outcome === "observed" ? { sources: Object.freeze(v.sources.map((s: NativeAudioLevel) => Object.freeze({ ...s }))) } : {}),
    ...(v.outcome === "observed" && version === 2 ? { mix: Object.freeze({ ...v.mix }), encoding: Object.freeze({ ...v.encoding,
      renditions: Object.freeze(v.encoding.renditions.map((r: any) => Object.freeze({ ...r }))) }) } : {}) });
}
