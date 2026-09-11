import "@angular/compiler";
import { afterEach, expect, it, vi } from "vitest";
import { SourceModerationService } from "./source-moderation.service";
import { validateServerMessageEnvelope } from "../webrtc/signaling.service";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it("subscribes without querying and fences room/identity/epoch state before releasing panel resources", () => {
  vi.useFakeTimers();
  let context: any = { key: "verified-owner-session", program: { programId: "prg_" + "a".repeat(16), programEpoch: 1, programRevision: 4 } };
  let receive: (message: any) => void = () => {};
  const unsubscribe = vi.fn(), send = vi.fn();
  const service = new SourceModerationService({ sceneContext: () => context } as never, {
    subscribe: (handler: typeof receive) => { receive = handler; return unsubscribe; }, sendSourceControl: send,
  } as never);
  expect(send).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
  service.controller.query(); const request = send.mock.calls[0][0];
  const state = { ...request, type: "broadcast-source-moderation-state", programRevision: 4, fencingRevision: 2,
    observedAt: Date.now(), expiresAt: Date.now() + 5000, sources: [] };
  expect(validateServerMessageEnvelope(state)).not.toBeNull();
  receive({ ...state, type: "trusted-source-publications" }); expect(service.view().phase).toBe("pending");
  receive(state); expect(service.view().phase).toBe("ready");
  context = { ...context, key: "new-owner-session" }; vi.advanceTimersByTime(250);
  expect(service.view().phase).toBe("stale"); expect(send).toHaveBeenCalledTimes(1);
  service.controller.query(); context = null; vi.advanceTimersByTime(250);
  receive(state); expect(service.view().state).toBeNull();
  service.ngOnDestroy(); expect(unsubscribe).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  receive(state); expect(service.view().state).toBeNull();
});
