import { describe, expect, it, vi } from "vitest";

import {
  BroadcastCockpitActionPort,
  BroadcastCockpitStartDraft,
  BroadcastCockpitWorkflow,
} from "./broadcast-cockpit-workflow";
import { BroadcastProgramStateService } from "./broadcast-program-state.service";

const NOW = 1_800_000_000_000;
const program = Object.freeze({
  tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha",
  programId: "prg_bbbbbbbbbbbbbbbb", programRevision: 1, programEpoch: 7,
});
const session = Object.freeze({
  sessionId: "session-aaaaaaaa", adapterId: "whip-runtime",
  programId: program.programId, programEpoch: program.programEpoch,
});

function draft(patch: Partial<BroadcastCockpitStartDraft> = {}): BroadcastCockpitStartDraft {
  return {
    tenantId: program.tenantId,
    roomId: program.roomId,
    programId: program.programId,
    programEpoch: program.programEpoch,
    sourceIds: ["src_cccccccccccccccc"],
    sourceLabels: ["Bildschirm"],
    audience: "private",
    layout: "screen-presenter",
    audioProfile: "speech",
    captionMode: "off",
    deliveryProfile: "origin-llhls",
    packagerRef: "brw_dddddddddddddddd",
    qualityProfile: "balanced",
    estimatedUploadBitsPerSecond: 2_000_000,
    estimatedCpuClass: "medium",
    ...patch,
  };
}

function harness() {
  const calls: string[] = [];
  const actions: BroadcastCockpitActionPort = {
    start: vi.fn(async () => { calls.push("start"); }),
    change: vi.fn(async () => { calls.push("change"); }),
    stopPublication: vi.fn(async () => { calls.push("stop-publication"); }),
    revokeGrants: vi.fn(async () => { calls.push("revoke-grants"); }),
    cleanupLocalSources: vi.fn(async () => { calls.push("cleanup-local"); }),
  };
  const state = new BroadcastProgramStateService();
  const workflow = new BroadcastCockpitWorkflow(state, actions, () => NOW, () => "a".repeat(32));
  return { state, workflow, actions, calls };
}

describe("BroadcastCockpitWorkflow", () => {
  it("requires a second local confirmation summarizing audience, sources and trust", async () => {
    const test = harness();
    const confirmation = test.workflow.requestStart(draft(), "user-action");
    expect(confirmation).toMatchObject({
      audienceLabel: "Privat", sourceLabels: ["Bildschirm"], interruptionExpected: false,
    });
    expect(confirmation.trustSummary).toContain("nicht Raum-SFrame-E2EE");
    expect(test.actions.start).not.toHaveBeenCalled();
    await expect(test.workflow.confirm(confirmation.confirmationId, "remote-signal")).rejects.toThrow(
      "explicit_broadcast_confirmation_required",
    );
    await test.workflow.confirm(confirmation.confirmationId, "user-action");
    expect(test.calls).toEqual(["start"]);
  });

  it("marks visibility or packager change as an interrupting handoff", async () => {
    const test = harness();
    test.state.begin(program);
    test.state.running(session);
    const states: string[] = [];
    const originalChange = test.actions.change;
    test.actions.change = vi.fn(async (value, signal) => {
      states.push(test.state.value().lifecycle);
      await originalChange(value, signal);
    });
    const confirmation = test.workflow.requestChange(draft({ audience: "public" }), "user-action");
    expect(confirmation.interruptionExpected).toBe(true);
    await test.workflow.confirm(confirmation.confirmationId, "user-action");
    expect(states).toEqual(["handing_over"]);
    expect(test.state.value().lifecycle).toBe("running");
  });

  it("runs publication stop, grant revoke and local cleanup even after a partial kill failure", async () => {
    const test = harness();
    test.state.begin(program);
    test.state.running(session);
    test.actions.stopPublication = vi.fn(async () => {
      test.calls.push("stop-publication");
      throw new Error("gateway_stop_failed");
    });
    await expect(test.workflow.kill("user-action")).rejects.toThrow("gateway_stop_failed");
    expect(test.calls).toEqual(["stop-publication", "revoke-grants", "cleanup-local"]);
    expect(test.state.value()).toMatchObject({ lifecycle: "failed", errorCode: "broadcast_kill_cleanup_failed" });
  });

  it("successful kill stays visible as stopped and is idempotent at each action boundary", async () => {
    const test = harness();
    test.state.begin(program);
    test.state.running(session);
    await test.workflow.kill("user-action");
    expect(test.calls).toEqual(["stop-publication", "revoke-grants", "cleanup-local"]);
    expect(test.state.value()).toMatchObject({ lifecycle: "stopped", errorCode: "broadcast_killed_by_user" });
  });

  it("never starts from restore, panel state, remote signals or an expired confirmation", async () => {
    const test = harness();
    expect(test.actions.start).not.toHaveBeenCalled();
    expect(() => test.workflow.requestStart(draft(), "restore")).toThrow("explicit_broadcast_confirmation_required");
    let now = NOW;
    const expired = new BroadcastCockpitWorkflow(test.state, test.actions, () => now, () => "b".repeat(32));
    const expiredConfirmation = expired.requestStart(draft(), "user-action");
    now = expiredConfirmation.expiresAt;
    await expect(expired.confirm(expiredConfirmation.confirmationId, "user-action")).rejects.toThrow(
      "broadcast_confirmation_expired",
    );
    expect(test.actions.start).not.toHaveBeenCalled();
  });

  it("keeps experimental MoQ unavailable in the cockpit draft", () => {
    const test = harness();
    expect(() => test.workflow.requestStart(draft({ deliveryProfile: "moq-experimental" }), "user-action"))
      .toThrow("broadcast_moq_disabled");
  });
});
