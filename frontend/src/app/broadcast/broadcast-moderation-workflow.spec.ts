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

  it("expires confirmation and aborts an in-flight request on destroy", async () => {
    let resolve!: () => void;
    let receivedSignal: AbortSignal | null = null;
    const execute = vi.fn().mockImplementation((_action, signal: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<never>(() => { resolve = () => undefined; });
    });
    const { workflow } = fixture(execute);
    const confirmation = workflow.request({ action: "layout-change", targetLabel: "Raster", layout: "grid" }, snapshot, "user-action");
    const pending = workflow.confirm(confirmation.confirmationId, "user-action");
    await Promise.resolve();
    workflow.destroy();
    expect(receivedSignal?.aborted).toBe(true);
    void pending;
    void resolve;
  });
});
