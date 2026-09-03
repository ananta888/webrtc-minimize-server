import { describe, expect, it, vi } from "vitest";

import { RoomSessionService } from "./room-session.service";

function createService(
  signalingLeave: () => void = () => undefined,
  meshClose: () => void = () => undefined,
) {
  const signaling = { leave: vi.fn(signalingLeave) };
  const mesh = { close: vi.fn(meshClose) };
  const service = new RoomSessionService(
    {} as never,
    {} as never,
    {} as never,
    signaling as never,
    mesh as never,
  );
  return { service, signaling, mesh };
}

describe("RoomSessionService teardown", () => {
  it("publishes the disconnected state before transport and mesh cleanup", () => {
    const observedJoinedStates: boolean[] = [];
    let service!: RoomSessionService;
    const created = createService(
      () => observedJoinedStates.push(service.joined()),
      () => observedJoinedStates.push(service.joined()),
    );
    service = created.service;
    service.joined.set(true);
    service.workspaceId.set("workspace");
    service.workspaceRole.set("owner");
    service.roomCreator.set(true);

    service.leave();

    expect(observedJoinedStates).toEqual([false, false]);
    expect(service.joined()).toBe(false);
    expect(service.workspaceId()).toBe("");
    expect(service.workspaceRole()).toBe("");
    expect(service.roomCreator()).toBe(false);
  });

  it("attempts both cleanup paths and remains disconnected if either path fails", () => {
    const { service, signaling, mesh } = createService(
      () => { throw new Error("transport cleanup failed"); },
      () => { throw new Error("mesh cleanup failed"); },
    );
    service.joined.set(true);

    expect(() => service.leave()).not.toThrow();

    expect(signaling.leave).toHaveBeenCalledOnce();
    expect(mesh.close).toHaveBeenCalledOnce();
    expect(service.joined()).toBe(false);
    expect(service.error()).toBe("session_cleanup_failed");
  });
});
