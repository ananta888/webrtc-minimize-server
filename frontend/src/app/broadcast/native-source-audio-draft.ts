import { NativeAudioSelection, NativeAudioState } from "./native-source-audio-contract";

export const sameAudioScope = (a: NativeAudioState, b: NativeAudioState): boolean =>
  (["audioControlVersion", "programId", "programRevision", "programEpoch", "packagerId", "assignmentId", "fencingRevision"] as const)
    .every(k => a[k] === b[k]);
export function sameAudioSettings(state: NativeAudioState, selection: NativeAudioSelection): boolean {
  return (state.mix?.strategy ?? undefined) === selection.strategy && state.sources.length === selection.sources.length
    && state.sources.every(source => selection.sources.some(input => input.sourceLeaseId === source.sourceLeaseId
      && input.leftGainQ15 === source.leftGainQ15 && input.rightGainQ15 === source.rightGainQ15 && input.muted === source.muted));
}
export function audioDraftRefresh(base: NativeAudioState | null, next: NativeAudioState, draft: NativeAudioSelection | null): "replace" | "retain" | "conflict" {
  if (!base || !draft || !sameAudioScope(base, next) || sameAudioSettings(base, draft) || sameAudioSettings(next, draft)) return "replace";
  const original: NativeAudioSelection = { expectedAudioRevision: base.audioRevision, sources: base.sources,
    ...(base.mix ? { strategy: base.mix.strategy } : {}) };
  return base.audioRevision === next.audioRevision && sameAudioSettings(next, original) ? "retain" : "conflict";
}
