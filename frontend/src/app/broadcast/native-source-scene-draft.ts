import { NativeSceneSelection, NativeSceneState } from "./native-source-scene-contract";

// A draft carries presentation intent, never freshness, consent or authority.
export function sameSceneScope(a: NativeSceneState, b: NativeSceneState): boolean {
  return a.programId === b.programId && a.programRevision === b.programRevision && a.programEpoch === b.programEpoch
    && a.packagerId === b.packagerId && a.assignmentId === b.assignmentId && a.fencingRevision === b.fencingRevision
    && a.sceneControlVersion === b.sceneControlVersion;
}

export function sameScenePresentation(state: NativeSceneState, selection: NativeSceneSelection): boolean {
  return state.layout === selection.layout && state.activeSourceLeaseId === selection.activeSourceLeaseId
    && JSON.stringify(state.sourceLeaseIds) === JSON.stringify(selection.sourceLeaseIds)
    && JSON.stringify(state.sourceFits) === JSON.stringify(selection.sourceFits);
}

export function sceneDraftRefresh(base: NativeSceneState | null, next: NativeSceneState,
  draft: NativeSceneSelection | null): "replace" | "retain" | "conflict" {
  if (!base || !draft || !sameSceneScope(base, next) || sameScenePresentation(base, draft)
    || sameScenePresentation(next, draft)) return "replace";
  return base.sceneRevision === next.sceneRevision && sameScenePresentation(next, {
    expectedSceneRevision: base.sceneRevision, layout: base.layout, sourceLeaseIds: base.sourceLeaseIds,
    activeSourceLeaseId: base.activeSourceLeaseId, ...(base.sourceFits ? { sourceFits: base.sourceFits } : {}),
  }) ? "retain" : "conflict";
}
