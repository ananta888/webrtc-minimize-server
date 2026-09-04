import { afterEach, describe, expect, it, vi } from "vitest";

import { BroadcastCaptionConsent, BroadcastCaptionSettings } from "./broadcast-caption-packager";
import { NativePackagerBroadcastRuntimeService } from "./native-packager-broadcast-runtime.service";

class FakeDataChannel {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = "closed"; });
  open(): void { this.readyState = "open"; this.onopen?.(); }
}

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  closed = false;
  readonly dataChannel = new FakeDataChannel();
  addTrack = vi.fn();
  createDataChannel = vi.fn(() => this.dataChannel as unknown as RTCDataChannel);
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
    })), setCaptionOverlay: vi.fn(() => true) };
    let captionListener: ((value: Record<string, unknown>) => void) | null = null;
    const captions = {
      registerEmissionListener: vi.fn((listener) => { captionListener = listener; return vi.fn(); }),
    };
    const captionConsent: BroadcastCaptionConsent = { policyVersion: 1, localOverlay: false, shareWithRoom: false,
      broadcastTextTrack: true, broadcastBurnIn: true };
    const currentCaptionSettings: BroadcastCaptionSettings = { settingsVersion: 1, modelId: "de-de-small-0.15", language: "de-DE",
        speakerMode: "off", speakerLabel: "", delayMs: 0, maximumLineLength: 42,
        positionPercent: 88, style: "high-contrast", syncBudgetMs: 3_000 };
    let captionSettingsListener: ((consent: BroadcastCaptionConsent, settings: BroadcastCaptionSettings) => void) | null = null;
    const captionSettings = {
      consent: () => captionConsent,
      settings: () => currentCaptionSettings,
      subscribe: vi.fn((listener) => { captionSettingsListener = listener; return vi.fn(); }),
    };
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
      control as never, composition as never, captions as never, captionSettings as never,
      onboarding as never, room as never, signaling as never,
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
    expect(pc.createDataChannel).toHaveBeenCalledWith("broadcast-captions-v1", { ordered: true });
    pc.dataChannel.open();
    captionListener?.({
      source: "screen-audio", sourceEpoch: 1, utteranceId: "0123456789abcdef",
      revision: 0, language: "de-DE", text: "geteilte präsentation", final: true,
      capturedAtMs: Date.now(),
    });
    const captionMessage = JSON.parse(String(pc.dataChannel.send.mock.calls.at(-1)?.[0]));
    expect(captionMessage).toMatchObject({
      version: 1, type: "caption-segment", operation: "update",
      assignmentId: assignment.assignmentId, programEpoch: 2, fencingRevision: 3,
      language: "de-DE", cueCount: 1,
    });
    expect(captionMessage.body).toContain("geteilte präsentation");
    expect(composition.setCaptionOverlay).toHaveBeenCalledWith(
      expect.objectContaining({ compositionId: "composition-test" }),
      "geteilte präsentation", "high-contrast", 88,
    );
    captionSettingsListener?.({ ...captionConsent, broadcastTextTrack: false, broadcastBurnIn: false }, currentCaptionSettings);
    expect(JSON.parse(String(pc.dataChannel.send.mock.calls.at(-1)?.[0]))).toMatchObject({
      operation: "revoke", discontinuitySequence: 1,
    });
    expect(composition.setCaptionOverlay).toHaveBeenCalledWith(
      expect.objectContaining({ compositionId: "composition-test" }), "", "high-contrast", 88,
    );
    await runtime.stop(session, new AbortController().signal);
    expect(pc.closed).toBe(true);
    expect(pc.dataChannel.close).toHaveBeenCalledOnce();
    expect(control.stopNativeAssignment).toHaveBeenCalledWith(assignment, expect.any(AbortSignal));
  });
});
