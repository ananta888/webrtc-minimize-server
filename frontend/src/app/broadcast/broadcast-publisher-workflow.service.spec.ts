import { afterEach, describe, expect, it, vi } from "vitest";

import { BroadcastPublisherWorkflowService } from "./broadcast-publisher-workflow.service";
import { BroadcastProgramStateService } from "./broadcast-program-state.service";

const draft = {
  tenantId: "tn_aaaaaaaaaaaaaaaa",
  roomId: "room-alpha",
  programId: "prg_bbbbbbbbbbbbbbbb",
  programRevision: 1,
  programEpoch: 1,
};
const prepared = { ...draft, programRevision: 3, programEpoch: 2 };
const source = {
  sourceId: "src_cccccccccccccccc",
  source: "camera" as const,
  kind: "video" as const,
  settings: {},
};

function fixture(createProgram?: (signal: AbortSignal) => Promise<typeof draft>) {
  const control = {
    createProgram: vi.fn(async (_roomId, _title, _visibility, signal: AbortSignal) => (
      createProgram ? createProgram(signal) : draft
    )),
    prepareStart: vi.fn(async () => ({ program: prepared, ownerSubjectRef: "sub_dddddddddddddddd" })),
    prepareNativeStart: vi.fn(async () => ({ program: prepared, ownerSubjectRef: "sub_dddddddddddddddd" })),
    nativeHandoffControl: vi.fn(async () => ({ controlVersion: 1, programId: prepared.programId,
      programRevision: 8, programEpoch: 2, state: "live", handoffPending: false,
      writer: { packagerId: "pkr_aaaaaaaaaaaaaaaa", fencingRevision: 3 } })),
    prepareNativeHandoff: vi.fn(async () => ({ program: { ...prepared, programRevision: 10, programEpoch: 3 },
      ownerSubjectRef: "sub_dddddddddddddddd" })),
    stopProgram: vi.fn(async () => {}),
    changeVisibility: vi.fn(async () => {}),
    clear: vi.fn(),
  };
  const coordinator = {
    programState: { value: vi.fn(() => ({ lifecycle: "idle", program: null })) },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const preflight = {
    preparePreview: vi.fn(async () => {}),
    stopPreview: vi.fn(async () => {}),
    resetForSession: vi.fn(async () => {}),
  };
  const media = {
    localOriginalSources: vi.fn(() => [source]),
    localPublicationRevision: vi.fn(() => 7),
  };
  return {
    service: new BroadcastPublisherWorkflowService(
      coordinator as never,
      control as never,
      preflight as never,
      media as never,
    ),
    control,
    coordinator,
    preflight,
    media,
  };
}

const request = {
  requestVersion: 1 as const,
  trigger: "user-action" as const,
  roomId: "room-alpha",
  title: "Pilot",
  visibility: "private" as const,
  sourceIds: [source.sourceId],
};

describe("BroadcastPublisherWorkflowService", () => {
  afterEach(() => vi.useRealTimers());
  it("keeps server revision, own-source snapshot and reverse stop under one owner", async () => {
    const context = fixture();
    await context.service.start(request);
    expect(context.control.prepareStart).toHaveBeenCalledWith(
      draft,
      request.sourceIds,
      expect.any(AbortSignal),
    );
    expect(context.coordinator.start).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "user-action",
      program: prepared,
      sourceIds: request.sourceIds,
      roomPublication: expect.objectContaining({
        roomId: request.roomId,
        publicationRevision: 7,
        sources: [expect.objectContaining({
          sourceId: source.sourceId,
          ownerSubjectRef: "sub_dddddddddddddddd",
          local: true,
        })],
      }),
    }), expect.any(AbortSignal));
    expect(context.service.activeProgramId()).toBe(draft.programId);

    context.coordinator.programState.value.mockReturnValue({ lifecycle: "running", program: prepared });
    await context.service.stop();
    expect(context.coordinator.stop).toHaveBeenCalledWith("user-stop");
    expect(context.control.stopProgram).toHaveBeenCalledWith(draft.programId, expect.any(AbortSignal));
    expect(context.service.activeProgramId()).toBe("");
  });

  it("aborts and awaits a pending create before session reset completes", async () => {
    const context = fixture((signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      void resolve;
    }));
    const start = context.service.start(request);
    await Promise.resolve();
    await context.service.resetForSession();
    await expect(start).rejects.toBeInstanceOf(DOMException);
    expect(context.control.prepareStart).not.toHaveBeenCalled();
    expect(context.coordinator.start).not.toHaveBeenCalled();
    expect(context.preflight.resetForSession).toHaveBeenCalledOnce();
  });

  it("fences the old program and rebuilds preview before a visibility restart", async () => {
    const context = fixture();
    await context.service.start(request);
    context.coordinator.programState.value.mockReturnValue({ lifecycle: "running", program: prepared });

    await context.service.setVisibility("public");

    expect(context.coordinator.stop).toHaveBeenCalledWith("visibility-change");
    expect(context.control.stopProgram).toHaveBeenCalledWith(draft.programId, expect.any(AbortSignal));
    expect(context.control.changeVisibility).not.toHaveBeenCalled();
    expect(context.preflight.preparePreview).toHaveBeenCalledWith("user-action");
    expect(context.control.createProgram).toHaveBeenLastCalledWith(
      request.roomId, request.title, "public", expect.any(AbortSignal),
    );
    expect(context.coordinator.start).toHaveBeenCalledTimes(2);
  });

  async function nativeFixture() {
    const context = fixture();
    const state = new BroadcastProgramStateService();
    context.coordinator.programState.value.mockImplementation(() => state.value() as never);
    Object.assign(context.coordinator.programState, {
      handingOver: state.handingOver.bind(state), resumeRunning: state.resumeRunning.bind(state),
      degraded: state.degraded.bind(state),
    });
    context.coordinator.start.mockImplementation(async (plan) => {
      state.begin(plan.program);
      state.running({ sessionId: `assignment-${plan.program.programEpoch}`, adapterId: "native-bridge",
        programId: plan.program.programId, programEpoch: plan.program.programEpoch });
    });
    context.coordinator.stop.mockImplementation(async () => { state.stopped(); });
    await context.service.start({ ...request, adapterId: "native-bridge", packagerId: "pkr_aaaaaaaaaaaaaaaa" });
    return { ...context, state };
  }

  it("hands the same program and sources to a new writer without create, preview or recapture", async () => {
    const f = await nativeFixture();
    await f.service.handoff("pkr_bbbbbbbbbbbbbbbb", 2, "user-action");
    expect(f.control.createProgram).toHaveBeenCalledOnce();
    expect(f.control.prepareNativeStart).toHaveBeenCalledOnce();
    expect(f.control.stopProgram).not.toHaveBeenCalled();
    expect(f.preflight.preparePreview).not.toHaveBeenCalled();
    expect(f.coordinator.stop).toHaveBeenCalledWith("packager-handoff");
    expect(f.coordinator.start).toHaveBeenLastCalledWith(expect.objectContaining({
      program: { ...prepared, programRevision: 10, programEpoch: 3 }, sourceIds: request.sourceIds,
    }), expect.any(AbortSignal));
    expect(f.state.value().lifecycle).toBe("running");
    expect(f.service.activeProgramId()).toBe(prepared.programId);
    expect(f.service.activePackagerId()).toBe("pkr_bbbbbbbbbbbbbbbb");
    expect(f.service.handingOver()).toBe(false);
  });

  it("preserves an authoritatively unchanged writer after admission conflict", async () => {
    const f = await nativeFixture();
    f.control.prepareNativeHandoff.mockRejectedValue(new Error("broadcast_state_conflict"));
    await expect(f.service.handoff("pkr_bbbbbbbbbbbbbbbb", 1, "user-action")).rejects.toThrow("broadcast_state_conflict");
    expect(f.control.nativeHandoffControl).toHaveBeenCalledTimes(2);
    expect(f.control.stopProgram).not.toHaveBeenCalled();
    expect(f.coordinator.stop).not.toHaveBeenCalled();
    expect(f.state.value().lifecycle).toBe("running");
    expect(f.service.activePackagerId()).toBe("pkr_aaaaaaaaaaaaaaaa");
  });

  for (const scenario of ["new-generation", "unknown-state", "source-ended", "successor-failed"]) {
    it(`cleans both sides and never recreates a program after ${scenario}`, async () => {
      const f = await nativeFixture();
      if (scenario === "new-generation" || scenario === "unknown-state") {
        f.control.prepareNativeHandoff.mockRejectedValue(new Error("handoff-failed"));
        const current = await f.control.nativeHandoffControl();
        f.control.nativeHandoffControl.mockResolvedValueOnce(current);
        if (scenario === "new-generation") f.control.nativeHandoffControl.mockResolvedValue({ ...current, programEpoch: 3 });
        else f.control.nativeHandoffControl.mockRejectedValue(new Error("offline"));
      } else if (scenario === "source-ended") f.media.localOriginalSources.mockReturnValue([]);
      else f.coordinator.start.mockRejectedValue(new Error("encoder-failed"));
      await expect(f.service.handoff("pkr_bbbbbbbbbbbbbbbb", 1, "user-action")).rejects.toThrow();
      expect(f.control.stopProgram).toHaveBeenCalledWith(prepared.programId, expect.any(AbortSignal));
      expect(f.control.createProgram).toHaveBeenCalledOnce();
      expect(f.control.clear).toHaveBeenCalledWith(prepared.programId);
      expect(f.service.activeProgramId()).toBe("");
      expect(f.service.activePackagerId()).toBe("");
      expect(f.service.handingOver()).toBe(false);
    });
  }

  for (const stage of ["http", "successor-start"]) {
    it(`Stop aborts and awaits ${stage}, rejects duplicate handoff and prevents revival`, async () => {
      const f = await nativeFixture();
      let entered!: () => void;
      const pending = new Promise<void>((resolve) => { entered = resolve; });
      const wait = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
        entered(); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      if (stage === "http") f.control.prepareNativeHandoff.mockImplementation((_program, _snapshot, _id, _count, signal) => wait(signal));
      else f.coordinator.start.mockImplementation((_plan, signal) => wait(signal));
      const task = f.service.handoff("pkr_bbbbbbbbbbbbbbbb", 1, "user-action");
      const rejected = expect(task).rejects.toBeInstanceOf(DOMException);
      await pending;
      await expect(f.service.handoff("pkr_cccccccccccccccc", 1, "user-action")).rejects.toThrow("invalid_native_handoff_request");
      await f.service.resetForSession();
      await rejected;
      expect(f.service.activeProgramId()).toBe("");
      expect(f.service.busy()).toBe(false);
      expect(f.preflight.resetForSession).toHaveBeenCalledOnce();
      expect(f.state.value().lifecycle).toBe("stopped");
    });
  }

  it("bounds a stalled handoff and denies remote triggers or the same target before HTTP", async () => {
    const f = await nativeFixture();
    await expect(f.service.handoff("pkr_bbbbbbbbbbbbbbbb", 1, "remote-signal")).rejects.toThrow("explicit_broadcast_handoff_required");
    await expect(f.service.handoff("pkr_aaaaaaaaaaaaaaaa", 1, "user-action")).rejects.toThrow("invalid_native_handoff_request");
    expect(f.control.nativeHandoffControl).not.toHaveBeenCalled();
    vi.useFakeTimers();
    f.control.prepareNativeHandoff.mockImplementation((_program, _snapshot, _id, _count, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const rejected = expect(f.service.handoff("pkr_bbbbbbbbbbbbbbbb", 1, "user-action")).rejects.toThrow("broadcast_handoff_timeout");
    await vi.advanceTimersByTimeAsync(75_000);
    await rejected;
    expect(f.control.stopProgram).toHaveBeenCalled();
    expect(f.service.activeProgramId()).toBe("");
  });
});
