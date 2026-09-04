import { afterEach, describe, expect, it, vi } from "vitest";

import { NativePackagerBroadcastRuntimeService } from "./native-packager-broadcast-runtime.service";

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  closed = false;
  addTrack = vi.fn();
  createOffer = vi.fn(async () => ({ type: "offer" as RTCSdpType, sdp: "v=0\r\n" }));
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = { ...description, toJSON: () => description } as RTCSessionDescription;
  });
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.remoteDescription = { ...description, toJSON: () => description } as RTCSessionDescription;
  });
  addIceCandidate = vi.fn(async () => undefined);
  getStats = vi.fn(async () => new Map());
  close(): void { this.closed = true; this.connectionState = "closed"; }
  connect(): void { this.connectionState = "connected"; this.dispatchEvent(new Event("connectionstatechange")); }
}

describe("NativePackagerBroadcastRuntimeService", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends an assignment-bound offer and stops both media and the remote lease", async () => {
    const pc = new FakePeerConnection();
    vi.stubGlobal("RTCPeerConnection", vi.fn(() => pc));
    let subscriber: ((message: Record<string, unknown>) => void) | null = null;
    const signaling = {
      subscribe: vi.fn((handler) => { subscriber = handler; return vi.fn(); }),
      send: vi.fn((message: Record<string, unknown>) => {
        if (message["description"]) {
          subscriber?.({ ...message, type: "native-packager-signal", description: { type: "answer", sdp: "v=0\r\n" } });
          queueMicrotask(() => {
            pc.connect();
            subscriber?.({
              version: 1, type: "native-packager-status", packagerId: assignment.packagerId,
              assignmentId: assignment.assignmentId, programId: assignment.programId,
              programEpoch: assignment.programEpoch, fencingRevision: assignment.fencingRevision,
              state: "running", reasonCode: "OUTPUT_READY", observedAt: Date.now(),
            });
          });
        }
      }),
    };
    const assignment = {
      assignmentId: "asn_0123456789abcdef", packagerId: "pkr_0123456789abcdef",
      programId: "prg_0123456789abcdef", programEpoch: 2, fencingRevision: 3, expiresAt: Date.now() + 30_000,
    };
    const control = { takePreparedNative: vi.fn(() => assignment), stopNativeAssignment: vi.fn(async () => undefined) };
    const composition = { resolve: vi.fn(async () => ({
      stream: {} as MediaStream,
      tracks: [{ track: {} as MediaStreamTrack }],
    })) };
    const onboarding = {
      selectedPackagerId: () => assignment.packagerId,
      eligible: () => [{ id: assignment.packagerId }],
    };
    const room = {
      joined: () => true, roomId: () => "room-alpha",
      icePolicy: () => ({ version: 1, directIceServers: [], peerRelayIceServers: [], infrastructureRelayIceServers: [],
        peerRelayAfterMs: 1_000, infrastructureRelayAfterMs: 2_000 }),
    };
    const runtime = new NativePackagerBroadcastRuntimeService(
      control as never, composition as never, onboarding as never, room as never, signaling as never,
    );
    const session = await runtime.start({
      requestVersion: 1,
      program: { tenantId: "tn_0123456789abcdef", roomId: "room-alpha", programId: assignment.programId,
        programRevision: 3, programEpoch: 2 },
      composition: { compositionId: "composition-test", sourceIds: ["src_0123456789abcdef"] },
    }, new AbortController().signal);
    expect(session).toMatchObject({ adapterId: "native-bridge", sessionId: assignment.assignmentId });
    expect(signaling.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "native-packager-signal", assignmentId: assignment.assignmentId, fencingRevision: 3,
    }));
    await runtime.stop(session, new AbortController().signal);
    expect(pc.closed).toBe(true);
    expect(control.stopNativeAssignment).toHaveBeenCalledWith(assignment, expect.any(AbortSignal));
  });
});
