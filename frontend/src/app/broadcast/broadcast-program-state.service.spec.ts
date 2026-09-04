import { describe, expect, it } from "vitest";

import { BroadcastProgramStateService } from "./broadcast-program-state.service";

const program = Object.freeze({
  tenantId: "tn_aaaaaaaaaaaaaaaa",
  roomId: "room-alpha",
  programId: "prg_bbbbbbbbbbbbbbbb",
  programRevision: 1,
  programEpoch: 7,
});
const session = Object.freeze({
  sessionId: "session-aaaaaaaa",
  adapterId: "whip-runtime",
  programId: program.programId,
  programEpoch: program.programEpoch,
});

describe("BroadcastProgramStateService", () => {
  it("keeps every operator-relevant live state visible and resumes only with the same session", () => {
    const state = new BroadcastProgramStateService();
    state.begin(program);
    state.running(session);
    state.degraded("gateway_health_low");
    expect(state.value()).toMatchObject({ lifecycle: "degraded", errorCode: "gateway_health_low" });
    state.reconnecting("gateway_reconnect");
    expect(state.value().lifecycle).toBe("reconnecting");
    state.handingOver("packager_handoff");
    expect(state.value().lifecycle).toBe("handing_over");
    state.resumeRunning();
    expect(state.value()).toMatchObject({ lifecycle: "running", errorCode: "" });
  });

  it("retains a stopped terminal summary until the next explicit begin", () => {
    const state = new BroadcastProgramStateService();
    state.setPanelVisible(true);
    state.begin(program);
    state.running(session);
    state.stopping();
    state.stopped("broadcast_stopped_by_user");
    expect(state.value()).toMatchObject({
      lifecycle: "stopped", panelVisible: true, program, publicationSession: null,
      errorCode: "broadcast_stopped_by_user",
    });
    state.begin({ ...program, programRevision: 2, programEpoch: 8 });
    expect(state.value()).toMatchObject({ lifecycle: "starting", errorCode: "" });
  });

  it("rejects degraded or handoff transitions without an active publication", () => {
    const state = new BroadcastProgramStateService();
    expect(() => state.degraded("remote-request")).toThrow("invalid_broadcast_active_transition");
    expect(() => state.handingOver("remote-request")).toThrow("invalid_broadcast_active_transition");
    expect(() => state.resumeRunning()).toThrow("invalid_broadcast_resume_transition");
  });
});
