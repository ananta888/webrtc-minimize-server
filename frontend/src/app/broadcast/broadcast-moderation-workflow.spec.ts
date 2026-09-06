import { describe, expect, it, vi } from "vitest";

import {
  BroadcastModerationActionPort,
  BroadcastModerationSnapshot,
  BroadcastModerationWorkflow,
  BroadcastModerationWorkflowError,
} from "./broadcast-moderation-workflow";

const NOW = 1_800_000_000_000;
const snapshot: BroadcastModerationSnapshot = Object.freeze({
  tenantId: "tn_aaaaaaaaaaaaaaaa",
  roomId: "room-alpha",
  programId: "prg_aaaaaaaaaaaaaaaa",
  programRevision: 7,
  programEpoch: 11,
  leaseEpoch: 13,
  actorSubjectRef: "sub_bbbbbbbbbbbbbbbb",
  actorRole: "owner",
});

function fixture(execute = vi.fn().mockResolvedValue({
  programRevision: 8,
  programEpoch: 11,
  leaseEpoch: 13,
})) {
  const safety = { fenceStopAndClear: vi.fn().mockResolvedValue(undefined) };
  let nonce = 0;
  const workflow = new BroadcastModerationWorkflow(
    { execute } as BroadcastModerationActionPort,
    safety,
    () => NOW,
    () => `${++nonce}`.padStart(32, "a"),
  );
  return { workflow, execute, safety };
}

describe("BroadcastModerationWorkflow", () => {
  it("requires a concrete local request and second confirmation", async () => {
    const { workflow, execute } = fixture();
    expect(() => workflow.request({ action: "layout-change", targetLabel: "Raster", layout: "grid" }, snapshot, "remote"))
      .toThrowError(new BroadcastModerationWorkflowError("explicit_broadcast_moderation_action_required"));
    const confirmation = workflow.request({ action: "layout-change", targetLabel: "Raster", layout: "grid" }, snapshot, "user-action");
    expect(confirmation).toMatchObject({ heading: "Programmlayout ändern", targetLabel: "Raster" });
    await expect(workflow.confirm(confirmation.confirmationId, "remote")).rejects
      .toThrowError(new BroadcastModerationWorkflowError("explicit_broadcast_moderation_confirmation_required"));
    expect(execute).not.toHaveBeenCalled();
  });

  it("binds confirmed requests to the visible revision, program epoch and lease epoch", async () => {
    const { workflow, execute } = fixture();
    const confirmation = workflow.request({
      action: "packager-handoff",
      targetLabel: "Laptop",
      primaryAgentId: "laptop",
    }, snapshot, "user-action");
    await workflow.confirm(confirmation.confirmationId, "user-action");
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      workflowVersion: 1,
      trigger: "user-action",
      expectedProgramRevision: 7,
      expectedProgramEpoch: 11,
      expectedLeaseEpoch: 13,
      primaryAgentId: "laptop",
    }), expect.any(AbortSignal));
  });

  it("stops and clears an own source locally before asking the control plane", async () => {
    const order: string[] = [];
    const execute = vi.fn().mockImplementation(async () => {
      order.push("server");
      throw new Error("network_unavailable");
    });
    const { workflow, safety } = fixture(execute);
    safety.fenceStopAndClear.mockImplementation(async () => { order.push("local-clear"); });
    const confirmation = workflow.request({
      action: "own-source-revoke",
      targetLabel: "Meine Kamera",
      targetSubjectRef: snapshot.actorSubjectRef,
      sourceId: "src_aaaaaaaaaaaaaaaa",
      reasonCode: "PUBLISHER_REVOKED",
    }, snapshot, "user-action");
    await expect(workflow.confirm(confirmation.confirmationId, "user-action")).rejects.toThrow("network_unavailable");
    expect(order).toEqual(["local-clear", "server"]);
  });

  it("never lets a user revoke another publisher through the own-source action", () => {
    const { workflow } = fixture();
    expect(() => workflow.request({
      action: "own-source-revoke",
      targetLabel: "Fremde Kamera",
      targetSubjectRef: "sub_cccccccccccccccc",
      sourceId: "src_aaaaaaaaaaaaaaaa",
      reasonCode: "PUBLISHER_REVOKED",
    }, snapshot, "user-action")).toThrowError(new BroadcastModerationWorkflowError("broadcast_own_source_required"));
  });

  it("allows one primary and at most two distinct keyless standbys", () => {
    const { workflow } = fixture();
    expect(() => workflow.request({
      action: "packager-select",
      targetLabel: "Agenten",
      primaryAgentId: "mini-pc",
      standbyAgentIds: ["mini-pc"],
    }, snapshot, "user-action")).toThrowError(new BroadcastModerationWorkflowError("invalid_broadcast_packager_selection"));
    expect(() => workflow.request({
      action: "packager-select",
      targetLabel: "Agenten",
      primaryAgentId: "mini-pc",
      standbyAgentIds: ["laptop", "desktop", "third"],
    }, snapshot, "user-action")).toThrowError(new BroadcastModerationWorkflowError("invalid_broadcast_packager_selection"));
  });

  it("surfaces stale revision and epoch conflicts for a fresh reload", async () => {
    const { workflow } = fixture(vi.fn().mockRejectedValue(new Error("stale_broadcast_epoch")));
    const confirmation = workflow.request({
      action: "program-stop",
      targetLabel: "Laufende Sendung",
      reasonCode: "OWNER_STOP",
    }, snapshot, "user-action");
    await expect(workflow.confirm(confirmation.confirmationId, "user-action")).rejects.toThrow("stale_broadcast_epoch");
    expect(workflow.conflictCode()).toBe("stale_broadcast_epoch");
  });

  it("settles an ignored in-flight request on destroy and cannot be revived", async () => {
    let receivedSignal: AbortSignal | null = null;
    const execute = vi.fn().mockImplementation((_action, signal: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<never>(() => {});
    });
    const { workflow } = fixture(execute);
    const confirmation = workflow.request({ action: "layout-change", targetLabel: "Raster", layout: "grid" }, snapshot, "user-action");
    const pending = workflow.confirm(confirmation.confirmationId, "user-action");
    await Promise.resolve();
    workflow.destroy();
    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow("broadcast_moderation_destroyed");
    expect(() => workflow.request({ action: "layout-change", targetLabel: "Raster", layout: "grid" }, snapshot, "user-action")).toThrow("broadcast_moderation_destroyed");
    await expect(workflow.confirm(confirmation.confirmationId, "user-action")).rejects.toThrow("broadcast_moderation_destroyed");
  });

  it("keeps the label local and rejects missing, unknown and cross-action fields", async () => {
    const { workflow, execute } = fixture();
    const draft = { action: "layout-change", targetLabel: "Private local label", layout: "grid" } as const;
    for (const value of [{ ...draft, extra: undefined }, { ...draft, primaryAgentId: "mini-pc" },
      { action: "layout-change", targetLabel: "Label" }, { ...draft, layout: ["grid"] },
      { action: "packager-standby", targetLabel: "Standbys", standbyAgentIds: Array(1) }]) {
      expect(() => workflow.request(value as never, snapshot, "user-action")).toThrow();
    }
    const confirmation = workflow.request(draft, snapshot, "user-action");
    await workflow.confirm(confirmation.confirmationId, "user-action");
    expect(execute.mock.calls[0][0]).not.toHaveProperty("targetLabel");
    expect(JSON.stringify(execute.mock.calls[0][0])).not.toContain(draft.targetLabel);
  });

  it("rejects malformed snapshots and stale or augmented adapter results", async () => {
    for (const patch of [{ actorRole: "admin" }, { tenantId: [snapshot.tenantId] }, { extra: undefined }]) {
      expect(() => fixture().workflow.request({ action: "program-stop", targetLabel: "Stop", reasonCode: "OWNER_STOP" }, { ...snapshot, ...patch } as never, "user-action")).toThrow("invalid_broadcast_moderation_snapshot");
    }
    for (const result of [null, { programRevision: 6, programEpoch: 11, leaseEpoch: 13 },
      { programRevision: 8, programEpoch: 10, leaseEpoch: 13 }, { programRevision: 8, programEpoch: 11, leaseEpoch: 12 },
      { programRevision: 8, programEpoch: 11, leaseEpoch: 13, secret: "never accepted" }]) {
      const { workflow } = fixture(vi.fn().mockResolvedValue(result));
      const confirmation = workflow.request({ action: "program-stop", targetLabel: "Stop", reasonCode: "OWNER_STOP" }, snapshot, "user-action");
      await expect(workflow.confirm(confirmation.confirmationId, "user-action")).rejects.toThrow("invalid_broadcast_moderation_result");
    }
  });

  it("allows only one execution and rejects new drafts while it is pending", async () => {
    let release!: (value: unknown) => void;
    const { workflow, execute } = fixture(vi.fn().mockImplementation(() => new Promise(resolve => { release = resolve; })));
    const draft = { action: "program-stop", targetLabel: "Stop", reasonCode: "OWNER_STOP" } as const;
    const confirmation = workflow.request(draft, snapshot, "user-action");
    const pending = workflow.confirm(confirmation.confirmationId, "user-action");
    expect(() => workflow.request(draft, snapshot, "user-action")).toThrow("broadcast_moderation_busy");
    await expect(workflow.confirm(confirmation.confirmationId, "user-action")).rejects.toThrow("broadcast_moderation_busy");
    expect(execute).toHaveBeenCalledTimes(1);
    release({ programRevision: 8, programEpoch: 11, leaseEpoch: 13 });
    await pending;
    expect(workflow.request(draft, snapshot, "user-action")).toBeTruthy();
  });

  it.each(["safety", "execute"])("bounds ignored %s promises and ignores late completion", async phase => {
    vi.useFakeTimers();
    try {
      let release!: (value?: unknown) => void;
      const { workflow, execute, safety } = fixture();
      (phase === "safety" ? safety.fenceStopAndClear : execute).mockImplementation(() => new Promise(resolve => { release = resolve; }));
      const confirmation = workflow.request({ action: "own-source-revoke", targetLabel: "Camera",
        targetSubjectRef: snapshot.actorSubjectRef, sourceId: "src_aaaaaaaaaaaaaaaa", reasonCode: "PUBLISHER_REVOKED" }, snapshot, "user-action");
      const pending = workflow.confirm(confirmation.confirmationId, "user-action");
      const rejected = expect(pending).rejects.toThrow("broadcast_moderation_timeout");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      const signal = (phase === "safety" ? safety : { fenceStopAndClear: execute }).fenceStopAndClear.mock.calls[0][1] as AbortSignal;
      expect(signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      release({ programRevision: 8, programEpoch: 11, leaseEpoch: 13 });
      await Promise.resolve(); await Promise.resolve();
      expect(execute).toHaveBeenCalledTimes(phase === "safety" ? 0 : 1);
      expect(workflow.conflictCode()).toBe(null);
    } finally { vi.useRealTimers(); }
  });

  it("never invokes the server after destroy during a delayed local revoke", async () => {
    let release!: () => void;
    const { workflow, execute, safety } = fixture();
    safety.fenceStopAndClear.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const confirmation = workflow.request({ action: "own-source-revoke", targetLabel: "Camera",
      targetSubjectRef: snapshot.actorSubjectRef, sourceId: "src_aaaaaaaaaaaaaaaa", reasonCode: "PUBLISHER_REVOKED" }, snapshot, "user-action");
    const pending = workflow.confirm(confirmation.confirmationId, "user-action");
    workflow.destroy();
    await expect(pending).rejects.toThrow("broadcast_moderation_destroyed");
    release();
    await Promise.resolve(); await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects expired, cancelled and replayed confirmations without network calls", async () => {
    let now = NOW;
    const execute = vi.fn().mockResolvedValue({ programRevision: 8, programEpoch: 11, leaseEpoch: 13 });
    const workflow = new BroadcastModerationWorkflow({ execute }, { fenceStopAndClear: async () => {} }, () => now);
    const draft = { action: "program-stop", targetLabel: "Stop", reasonCode: "OWNER_STOP" } as const;
    const expired = workflow.request(draft, snapshot, "user-action");
    now += 120_000;
    await expect(workflow.confirm(expired.confirmationId, "user-action")).rejects.toThrow("broadcast_moderation_confirmation_expired");
    const cancelled = workflow.request(draft, snapshot, "user-action");
    workflow.cancel();
    await expect(workflow.confirm(cancelled.confirmationId, "user-action")).rejects.toThrow("broadcast_moderation_confirmation_expired");
    expect(execute).not.toHaveBeenCalled();
    const valid = workflow.request(draft, snapshot, "user-action");
    await workflow.confirm(valid.confirmationId, "user-action");
    await expect(workflow.confirm(valid.confirmationId, "user-action")).rejects.toThrow("broadcast_moderation_confirmation_expired");
    expect(execute).toHaveBeenCalledTimes(1);
    workflow.destroy();
  });

  it("clears its deadline on a local revoke failure without invoking the server", async () => {
    vi.useFakeTimers();
    try {
      const { workflow, execute, safety } = fixture();
      safety.fenceStopAndClear.mockRejectedValue(new Error("source_cleanup_failed"));
      const confirmation = workflow.request({ action: "own-source-revoke", targetLabel: "Camera",
        targetSubjectRef: snapshot.actorSubjectRef, sourceId: "src_aaaaaaaaaaaaaaaa", reasonCode: "PUBLISHER_REVOKED" }, snapshot, "user-action");
      await expect(workflow.confirm(confirmation.confirmationId, "user-action")).rejects.toThrow("source_cleanup_failed");
      expect(execute).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("a late response cannot release the next operation's exclusive lifetime", async () => {
    vi.useFakeTimers();
    try {
      let releaseOld!: (value: unknown) => void;
      const execute = vi.fn().mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }))
        .mockImplementation(() => new Promise(() => {}));
      const { workflow } = fixture(execute);
      const draft = { action: "program-stop", targetLabel: "Stop", reasonCode: "OWNER_STOP" } as const;
      const first = workflow.request(draft, snapshot, "user-action");
      const expired = expect(workflow.confirm(first.confirmationId, "user-action")).rejects.toThrow("broadcast_moderation_timeout");
      await vi.advanceTimersByTimeAsync(10_000); await expired;
      const second = workflow.request(draft, snapshot, "user-action");
      const pending = workflow.confirm(second.confirmationId, "user-action");
      releaseOld({ programRevision: 8, programEpoch: 11, leaseEpoch: 13 });
      await Promise.resolve(); await Promise.resolve();
      expect(() => workflow.request(draft, snapshot, "user-action")).toThrow("broadcast_moderation_busy");
      workflow.destroy();
      await expect(pending).rejects.toThrow("broadcast_moderation_destroyed");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not execute a confirmation that expired during local source cleanup", async () => {
    let now = NOW;
    const execute = vi.fn();
    const workflow = new BroadcastModerationWorkflow({ execute }, { fenceStopAndClear: async () => { now += 120_000; } }, () => now);
    const confirmation = workflow.request({ action: "own-source-revoke", targetLabel: "Camera",
      targetSubjectRef: snapshot.actorSubjectRef, sourceId: "src_aaaaaaaaaaaaaaaa", reasonCode: "PUBLISHER_REVOKED" }, snapshot, "user-action");
    await expect(workflow.confirm(confirmation.confirmationId, "user-action")).rejects.toThrow("broadcast_moderation_confirmation_expired");
    expect(execute).not.toHaveBeenCalled();
    workflow.destroy();
  });
});
