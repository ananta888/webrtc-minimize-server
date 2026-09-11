export interface ModeratedSource {
  readonly consentId: string; readonly sourceId: string;
  readonly sourceKind: "camera" | "microphone" | "screen" | "screen-audio";
  readonly publisherPeerId: string; readonly expiresAt: number;
}
export interface SourceModerationState {
  readonly version: 1; readonly type: "broadcast-source-moderation-state"; readonly requestId: string;
  readonly programId: string; readonly programEpoch: number; readonly programRevision: number;
  readonly fencingRevision: number; readonly observedAt: number; readonly expiresAt: number;
  readonly sources: readonly ModeratedSource[];
}
type RecordValue = Record<string, unknown>;
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const id = (v: unknown, pattern: RegExp): v is string => typeof v === "string" && pattern.test(v);
export function exactModerationObject(value: unknown, keys: string[]): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length
    && Object.keys(value).every(k => keys.includes(k));
}
export function parseSourceModerationState(value: unknown): SourceModerationState | null {
  if (!exactModerationObject(value, ["version", "type", "requestId", "programId", "programEpoch", "programRevision",
    "fencingRevision", "observedAt", "expiresAt", "sources"]) || value["version"] !== 1
    || value["type"] !== "broadcast-source-moderation-state"
    || !id(value["requestId"], /^[A-Za-z0-9_-]{16,64}$/) || !id(value["programId"], /^prg_[A-Za-z0-9_-]{16,64}$/)
    || !["programEpoch", "programRevision", "fencingRevision", "observedAt", "expiresAt"].every(k => positive(value[k]))
    || (value["expiresAt"] as number) <= (value["observedAt"] as number)
    || (value["expiresAt"] as number) - (value["observedAt"] as number) > 5000
    || !Array.isArray(value["sources"]) || value["sources"].length > 80) return null;
  const consents = new Set(), sources = new Set();
  for (const s of value["sources"]) {
    if (!exactModerationObject(s, ["consentId", "sourceId", "sourceKind", "publisherPeerId", "expiresAt"])
      || !id(s["consentId"], /^cns_[A-Za-z0-9_-]{16,64}$/) || !id(s["sourceId"], /^src_[A-Za-z0-9_-]{16,64}$/)
      || !id(s["publisherPeerId"], /^[a-f0-9]{16}$/) || !positive(s["expiresAt"])
      || s["expiresAt"] <= (value["observedAt"] as number)
      || !["camera", "microphone", "screen", "screen-audio"].includes(s["sourceKind"] as string)
      || consents.has(s["consentId"]) || sources.has(s["sourceId"])) return null;
    consents.add(s["consentId"]); sources.add(s["sourceId"]);
  }
  return Object.freeze({ ...value, sources: Object.freeze(value["sources"].map(s => Object.freeze({ ...s }))) }) as unknown as SourceModerationState;
}
