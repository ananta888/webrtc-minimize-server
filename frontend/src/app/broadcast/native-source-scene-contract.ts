export const SCENE_LAYOUTS = ["single", "screen-presenter", "side-by-side", "active-speaker", "grid", "waiting-slate", "end-slate"] as const;
export type SceneLayout = typeof SCENE_LAYOUTS[number];
export type SceneFit = "contain" | "cover";
interface SceneScope {
  readonly sceneControlVersion: 1 | 2; readonly programId: string; readonly programRevision: number;
  readonly programEpoch: number; readonly packagerId: string; readonly assignmentId: string; readonly fencingRevision: number;
}
export interface NativeSceneState extends SceneScope {
  readonly outcome: "observed"; readonly observedAt: number; readonly sceneRevision: number; readonly layout: SceneLayout;
  readonly sourceLeaseIds: readonly string[]; readonly activeSourceLeaseId: string;
  readonly sourceFits?: readonly SceneFit[];
  readonly availableSources: readonly Readonly<{ sourceLeaseId: string; sourceKind: "camera" | "screen" }>[];
}
export type NativeSceneResult = NativeSceneState
  | (SceneScope & Readonly<{ outcome: "applied"; appliedAt: number; sceneRevision: number }>)
  | (SceneScope & Readonly<{ outcome: "rejected"; observedAt: number; reasonCode: "SCENE_NOT_APPLIED" }>);
export interface NativeSceneSelection {
  readonly expectedSceneRevision: number; readonly layout: SceneLayout;
  readonly sourceLeaseIds: readonly string[]; readonly activeSourceLeaseId: string;
  readonly sourceFits?: readonly SceneFit[];
}
const ref = (v: unknown, prefix: string): v is string => typeof v === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`).test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const closed = (v: any, fields: string[]) => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === fields.length && Object.keys(v).every(k => fields.includes(k));
const fail = () => { throw new Error("invalid_native_scene_response"); };
export function validSceneSelection(value: NativeSceneSelection): boolean {
  return positive(value.expectedSceneRevision) && value.expectedSceneRevision < Number.MAX_SAFE_INTEGER
    && SCENE_LAYOUTS.includes(value.layout) && Array.isArray(value.sourceLeaseIds) && value.sourceLeaseIds.length <= 20
    && value.sourceLeaseIds.every(id => ref(id, "sls")) && new Set(value.sourceLeaseIds).size === value.sourceLeaseIds.length
    && (value.activeSourceLeaseId === "" || ["single", "active-speaker"].includes(value.layout) && value.sourceLeaseIds.includes(value.activeSourceLeaseId))
    && (value.sourceFits === undefined || Array.isArray(value.sourceFits) && value.sourceFits.length === value.sourceLeaseIds.length
      && value.sourceFits.every(fit => fit === "contain" || fit === "cover"));
}
export function parseNativeSceneResult(raw: unknown, program: { programId: string; programRevision: number; programEpoch: number }, now = Date.now()): NativeSceneResult {
  const v = raw as any, fields = ["sceneControlVersion", "programId", "programRevision", "programEpoch", "packagerId", "assignmentId", "fencingRevision", "outcome"];
  if (v?.outcome === "observed") fields.push("observedAt", "sceneRevision", "layout", "sourceLeaseIds", "activeSourceLeaseId", "availableSources");
  else if (v?.outcome === "applied") fields.push("appliedAt", "sceneRevision");
  else if (v?.outcome === "rejected") fields.push("observedAt", "reasonCode");
  else fail();
  if (v?.outcome === "observed" && v.sceneControlVersion === 2) fields.push("sourceFits");
  if (!closed(v, fields) || ![1, 2].includes(v.sceneControlVersion) || !ref(v.programId, "prg") || v.programId !== program.programId
    || !positive(v.programRevision) || v.programRevision !== program.programRevision || !positive(v.programEpoch) || v.programEpoch !== program.programEpoch
    || !ref(v.packagerId, "pkr") || !ref(v.assignmentId, "asn") || !positive(v.fencingRevision)) fail();
  const time = v.outcome === "applied" ? v.appliedAt : v.observedAt;
  if (!positive(now) || !positive(time) || time > now + 1000 || time <= now - 5000) fail();
  if (v.outcome === "applied" && (!positive(v.sceneRevision) || v.sceneRevision < 2)) fail();
  if (v.outcome === "rejected" && v.reasonCode !== "SCENE_NOT_APPLIED") fail();
  if (v.outcome !== "observed") return Object.freeze({ ...v });
  if (!positive(v.sceneRevision) || !validSceneSelection({ ...v, expectedSceneRevision: 1 })
    || v.sceneControlVersion === 2 && !Array.isArray(v.sourceFits)
    || !Array.isArray(v.availableSources) || v.availableSources.length > 80
    || v.availableSources.some((s: any) => !closed(s, ["sourceLeaseId", "sourceKind"]) || !ref(s.sourceLeaseId, "sls") || !["camera", "screen"].includes(s.sourceKind))
    || new Set(v.availableSources.map((s: any) => s.sourceLeaseId)).size !== v.availableSources.length) fail();
  return Object.freeze({ ...v, sourceLeaseIds: Object.freeze([...v.sourceLeaseIds]),
    ...(v.sceneControlVersion === 2 ? { sourceFits: Object.freeze([...v.sourceFits]) } : {}),
    availableSources: Object.freeze(v.availableSources.map((s: any) => Object.freeze({ ...s }))) });
}
