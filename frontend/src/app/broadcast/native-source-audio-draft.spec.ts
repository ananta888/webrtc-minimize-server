import "@angular/compiler";
import { signal } from "@angular/core";
import { afterEach, expect, it, vi } from "vitest";
import { NativeAudioState } from "./native-source-audio-contract";
import { NativeAudioView } from "./native-source-audio-controller";
import { NativeSourceAudioComponent } from "./native-source-audio.component";
import { audioDraftRefresh } from "./native-source-audio-draft";

const source = "sls_aaaaaaaaaaaaaaaa";
const audioDraftState: NativeAudioState = { audioControlVersion: 2, outcome: "observed", observedAt: 1800000000000,
  programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 1, programEpoch: 1, packagerId: "pkr_aaaaaaaaaaaaaaaa",
  assignmentId: "asn_aaaaaaaaaaaaaaaa", fencingRevision: 1, audioRevision: 1,
  sources: [{ sourceLeaseId: source, sourceKind: "microphone", leftGainQ15: 32768, rightGainQ15: 32768, muted: false }],
  mix: { strategy: "balanced", microphoneGainQ15: 32768, screenAudioGainQ15: 32768, limiterGainQ15: 32768, peakQ15: 0 },
  encoding: { codec: "aac", sampleRate: 48000, channels: 2, renditions: [{ id: "low", targetBitsPerSecond: 64000 }] } };
afterEach(() => vi.restoreAllMocks());
function fixture() {
  let next = audioDraftState;
  const owner = signal<string | null>("owner-alpha");
  const audio = { ownerKey: () => owner(), view: signal<NativeAudioView>({ phase: "idle", audio: null }), controller: {
    refresh: vi.fn(async () => { audio.view.set({ phase: "ready", audio: next }); }), apply: vi.fn(async () => {}),
  } };
  const detector = { detectChanges: vi.fn() }, component = new NativeSourceAudioComponent(audio as never, detector as never);
  return { audio, owner, detector, component, next: (value: NativeAudioState) => { next = value; } };
}

it("keeps same-revision audio drafts across fresh observations without treating mixer telemetry as changes", async () => {
  const f = fixture(); await f.component.refresh();
  f.component.setGain(source, "leftGainQ15", "50"); f.component.setMuted(source, true); f.component.setStrategy("speech-first");
  expect(f.component.dirty()).toBe(true);
  f.audio.view.set({ phase: "stale", audio: null });
  expect(f.component.editable()).toBe(true); expect(f.component.canApply()).toBe(false);
  f.component.setGain(source, "rightGainQ15", "25");
  f.next({ ...audioDraftState, mix: { ...audioDraftState.mix!, peakQ15: 1234, microphoneGainQ15: 18000 } });
  await f.component.refresh(); expect(f.component.draftConflict()).toBe(false); expect(f.component.canApply()).toBe(true);
  expect(f.component.levels()[0]).toMatchObject({ leftGainQ15: 16384, rightGainQ15: 8192, muted: true });
  expect(f.component.strategy()).toBe("speech-first"); expect(f.audio.controller.apply).not.toHaveBeenCalled();
});

it("requires a separate review and apply confirmation after concurrent audio revision changes", async () => {
  const f = fixture(); await f.component.refresh(); f.component.setGain(source, "leftGainQ15", "50");
  f.next({ ...audioDraftState, audioRevision: 2 }); await f.component.refresh();
  expect(f.component.draftConflict()).toBe(true); expect(f.component.canApply()).toBe(false);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false); f.component.reviewDraft(true);
  expect(f.component.draftConflict()).toBe(true);
  confirm.mockReturnValue(true); f.component.reviewDraft(true); expect(f.component.canApply()).toBe(true);
  expect(f.audio.controller.apply).not.toHaveBeenCalled();
  await f.component.apply(); expect(f.audio.controller.apply).toHaveBeenCalledExactlyOnceWith({ expectedAudioRevision: 2,
    strategy: "balanced", sources: [{ sourceLeaseId: source, leftGainQ15: 16384, rightGainQ15: 32768, muted: false }] }, "user-action");
  expect(confirm).toHaveBeenCalledTimes(3);
});

it.each(["owner", "revision", "epoch", "packager", "assignment", "fence"])("does not carry an audio draft into another %s scope", async kind => {
  const f = fixture(); await f.component.refresh(); f.component.setMuted(source, true);
  let next = { ...audioDraftState };
  if (kind === "owner") f.owner.set("owner-beta");
  if (kind === "revision") next.programRevision++;
  if (kind === "epoch") next.programEpoch++;
  if (kind === "packager") next.packagerId = "pkr_bbbbbbbbbbbbbbbb";
  if (kind === "assignment") next.assignmentId = "asn_bbbbbbbbbbbbbbbb";
  if (kind === "fence") next.fencingRevision++;
  f.next(next); await f.component.refresh();
  expect(f.component.levels()[0].muted).toBe(false); expect(f.component.dirty()).toBe(false);
  expect(f.component.draftConflict()).toBe(false); expect(f.audio.controller.apply).not.toHaveBeenCalled();
});

it("removes revoked draft inputs only explicitly and never turns review into apply or consent", async () => {
  const f = fixture(); await f.component.refresh(); f.component.setMuted(source, true);
  f.component.removeUnavailable(source); expect(f.component.levels()).toHaveLength(1);
  f.next({ ...audioDraftState, audioRevision: 2, sources: [] }); await f.component.refresh();
  expect(f.component.draftConflict()).toBe(true); expect(f.component.sourceUnavailable(source)).toBe(true);
  vi.spyOn(window, "confirm").mockReturnValue(true); f.component.reviewDraft(true);
  expect(f.component.canApply()).toBe(false); expect(f.component.sourceLabel(source)).toBe("Nicht verfügbare Quelle");
  f.component.removeUnavailable(source); expect(f.component.canApply()).toBe(true);
  expect(f.audio.controller.apply).not.toHaveBeenCalled();
});

it("rejects re-entrant edits before hydration, drops late owner responses and hides old values", async () => {
  const f = fixture(); await f.component.refresh();
  let finish!: () => void;
  f.audio.controller.refresh.mockImplementationOnce(async () => {
    f.audio.view.set({ phase: "ready", audio: audioDraftState });
    await new Promise<void>(resolve => { finish = resolve; });
  });
  const pending = f.component.refresh(); expect(f.component.editable()).toBe(false); expect(f.component.canApply()).toBe(false);
  f.component.setMuted(source, true); f.component.setStrategy("screen-first"); await f.component.refresh();
  expect(f.audio.controller.refresh).toHaveBeenCalledTimes(2); expect(f.component.levels()[0].muted).toBe(false);
  f.owner.set(null); finish(); await pending;
  expect(f.component.formState()).toBe(null); expect(f.component.refreshing()).toBe(false); expect(f.detector.detectChanges).toHaveBeenCalledTimes(2);
});

it("rechecks current context inside review and apply dialogs and restores invalid number input", async () => {
  const f = fixture(); await f.component.refresh();
  for (const text of ["", " ", "-1", "101", "NaN", "Infinity"]) expect(f.component.setGain(source, "leftGainQ15", text)).toBe("100");
  expect(f.component.setGain(source, "leftGainQ15", "33.3")).toBe("33.3");
  const confirm = vi.spyOn(window, "confirm").mockImplementation(() => { f.owner.set("owner-beta"); return true; });
  await f.component.apply(); expect(f.audio.controller.apply).not.toHaveBeenCalled();
  f.owner.set("owner-alpha"); f.next({ ...audioDraftState, audioRevision: 2 }); await f.component.refresh();
  confirm.mockImplementation(() => { f.audio.view.set({ phase: "stale", audio: null }); return true; });
  f.component.reviewDraft(true); expect(f.component.draftConflict()).toBe(true);
});

it("does not rebase a same-revision settings change or revision rollback silently", () => {
  const draft = { expectedAudioRevision: 1, strategy: "balanced" as const, sources: [{ ...audioDraftState.sources[0], muted: true }] };
  expect(audioDraftRefresh(audioDraftState, { ...audioDraftState, sources: [{ ...audioDraftState.sources[0], leftGainQ15: 10000 }] }, draft)).toBe("conflict");
  expect(audioDraftRefresh({ ...audioDraftState, audioRevision: 2 }, audioDraftState, { ...draft, expectedAudioRevision: 2 })).toBe("conflict");
  expect(audioDraftRefresh(audioDraftState, { ...audioDraftState, sources: [{ ...audioDraftState.sources[0], muted: true }] }, draft)).toBe("replace");
});
