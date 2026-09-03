import { describe, expect, it, vi } from "vitest";

import { BroadcastPlaybackService } from "./broadcast-playback.service";
import { BroadcastPlaybackPort, BroadcastPlaybackRequest } from "./broadcast-ports";

function request(): BroadcastPlaybackRequest {
  return {
    requestVersion: 1,
    trigger: "user-action",
    programId: "prg_aaaaaaaaaaaaaaaa",
    programEpoch: 7,
    policyRevision: 3,
  };
}

describe("BroadcastPlaybackService", () => {
  it("does not open playback with its constructor or panel and closes an explicit session", async () => {
    const port: BroadcastPlaybackPort = {
      open: vi.fn(async (input) => ({
        playbackSessionId: "playback-session-1",
        programId: input.programId,
        programEpoch: input.programEpoch,
      })),
      close: vi.fn(async () => undefined),
    };
    const service = new BroadcastPlaybackService(port);
    service.setPanelVisible(true);
    expect(port.open).not.toHaveBeenCalled();

    await service.open(request());
    expect(service.lifecycle()).toBe("playing");
    expect(port.open).toHaveBeenCalledOnce();
    await service.close();
    expect(port.close).toHaveBeenCalledOnce();
    expect(service.lifecycle()).toBe("idle");
  });

  it("rejects non-user triggers and aborts an opening request on destroy", async () => {
    const port: BroadcastPlaybackPort = {
      open: (_input, signal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      }),
      close: vi.fn(async () => undefined),
    };
    const service = new BroadcastPlaybackService(port);
    await expect(service.open({
      ...request(),
      trigger: "panel-open",
    } as unknown as BroadcastPlaybackRequest)).rejects.toThrow("explicit_broadcast_playback_required");

    const opening = service.open(request());
    await Promise.resolve();
    const destroying = service.destroy();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    await destroying;
    expect(service.lifecycle()).toBe("idle");
    expect(service.panelVisible()).toBe(false);
    await expect(service.open(request())).rejects.toThrow("broadcast_playback_destroyed");
  });

  it("retains a session when close fails and permits deterministic cleanup retry", async () => {
    let failClose = true;
    const port: BroadcastPlaybackPort = {
      open: vi.fn(async (input) => ({
        playbackSessionId: "playback-session-1",
        programId: input.programId,
        programEpoch: input.programEpoch,
      })),
      close: vi.fn(async () => {
        if (failClose) {
          failClose = false;
          throw new Error("playback_close_failed");
        }
      }),
    };
    const service = new BroadcastPlaybackService(port);
    await service.open(request());

    await expect(service.close()).rejects.toThrow("playback_close_failed");
    expect(service.lifecycle()).toBe("failed");
    expect(service.session()?.playbackSessionId).toBe("playback-session-1");
    await service.close();
    expect(port.close).toHaveBeenCalledTimes(2);
    expect(service.session()).toBeNull();
    expect(service.lifecycle()).toBe("idle");
  });
});
