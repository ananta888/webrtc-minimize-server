import { NativeSceneState } from "./native-source-scene-contract";

export interface NativeSourceBinding {
  readonly sourceLeaseId: string;
  readonly publisherPeerId: string;
  readonly sourceKind: "camera" | "screen" | "microphone" | "screen-audio";
}
export type NativeSourceLabelsScope = Pick<NativeSceneState, "programId" | "programRevision" | "programEpoch" | "packagerId" | "assignmentId" | "fencingRevision">;
export interface NativeSourceLabels extends NativeSourceLabelsScope {
  readonly version: 1;
  readonly bindings: readonly NativeSourceBinding[];
}
const fields = ["programId", "programRevision", "programEpoch", "packagerId", "assignmentId", "fencingRevision"] as const;
const closed = (v: any, keys: readonly string[]) => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const ref = (v: unknown, prefix: string) => typeof v === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`).test(v);
const positive = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
const fail = (): never => { throw new Error("invalid_native_source_labels_response"); };

export function parseNativeSourceLabels(raw: unknown, scene: NativeSceneState): NativeSourceLabels {
  const v = raw as any;
  if (!closed(v, ["version", ...fields, "bindings"]) || v.version !== 1
    || fields.some(k => v[k] !== scene[k]) || !ref(v.programId, "prg") || !ref(v.packagerId, "pkr") || !ref(v.assignmentId, "asn")
    || !positive(v.programRevision) || !positive(v.programEpoch) || !positive(v.fencingRevision)
    || !Array.isArray(v.bindings) || v.bindings.length > 80
    || v.bindings.some((b: any) => !closed(b, ["sourceLeaseId", "publisherPeerId", "sourceKind"])
      || !ref(b.sourceLeaseId, "sls") || typeof b.publisherPeerId !== "string" || !/^[a-f0-9]{16}$/.test(b.publisherPeerId)
      || !scene.availableSources.some(s => s.sourceLeaseId === b.sourceLeaseId && s.sourceKind === b.sourceKind))
    || new Set(v.bindings.map((b: any) => b.sourceLeaseId)).size !== v.bindings.length) fail();
  return Object.freeze({ ...v, bindings: Object.freeze(v.bindings.map((b: NativeSourceBinding) => Object.freeze({ ...b }))) });
}
