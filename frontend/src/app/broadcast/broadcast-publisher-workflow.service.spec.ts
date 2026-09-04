import { describe, expect, it, vi } from "vitest";

import { BroadcastPublisherWorkflowService } from "./broadcast-publisher-workflow.service";

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
    stopProgram: vi.fn(async () => {}),
    changeVisibility: vi.fn(async () => {}),
  };
  const coordinator = {
    programState: { value: vi.fn(() => ({ lifecycle: "idle", program: null })) },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const preflight = {
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
    }));
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
});
