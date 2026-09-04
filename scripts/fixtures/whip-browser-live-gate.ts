import { BroadcastPublicationRequest } from "../../frontend/src/app/broadcast/broadcast-ports";
import { Rfc9725WhipTransport } from "../../frontend/src/app/broadcast/whip-browser-transport";

declare global {
  interface Window {
    __WHIP_GATE_ENDPOINT__: string;
    __whipGateResult?: Readonly<Record<string, unknown>>;
  }
}

const button = document.querySelector<HTMLButtonElement>("#run-whip-gate");
if (!button) throw new Error("live_gate_button_missing");

button.addEventListener("click", async () => {
  button.disabled = true;
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("live_gate_canvas_unavailable");
  context.fillStyle = "#32d3a4";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const stream = canvas.captureStream(10);
  const request: BroadcastPublicationRequest = {
    requestVersion: 1,
    program: {
      tenantId: "tn_aaaaaaaaaaaaaaaa",
      roomId: "room-live-gate",
      programId: "prg_aaaaaaaaaaaaaaaa",
      programRevision: 1,
      programEpoch: 1,
    },
    composition: {
      compositionId: "composition-live-gate",
      sourceIds: ["src_aaaaaaaaaaaaaaaa"],
    },
  };
  const transport = new Rfc9725WhipTransport({
    configurationVersion: 1,
    compatibilityProfile: "mediamtx-1.20",
    endpointUrl: window.__WHIP_GATE_ENDPOINT__,
    allowedRedirectOrigins: [],
    iceServers: [],
    codecPreferences: { audio: [], video: ["video/vp8"] },
    simulcast: { enabled: false, sendEncodings: [] },
    trickleIce: true,
    requestTimeoutMs: 8_000,
    iceGatheringTimeoutMs: 10_000,
    connectionTimeoutMs: 15_000,
    maximumResponseBytes: 128 * 1024,
    maximumSdpBytes: 64 * 1024,
    maximumIceFragmentBytes: 16 * 1024,
    maximumCandidates: 64,
    retryBudget: 1,
  }, {
    allowLoopbackHttpForTests: true,
    media: { resolve: async () => stream },
    authorization: {
      authorize: async () => ({
        authorizationVersion: 1,
        accessToken: "live-gate-bearer-not-a-production-secret",
        expiresAt: Date.now() + 60_000,
      }),
    },
  });
  try {
    const session = await transport.start(request, new AbortController().signal);
    const connected = transport.status(session);
    let restartError = "";
    try {
      await transport.restartIce(session, new AbortController().signal);
    } catch (error) {
      restartError = error instanceof Error ? error.message : "unknown_restart_error";
    }
    await transport.stop(session, new AbortController().signal);
    window.__whipGateResult = Object.freeze({
      connected: connected.lifecycle === "connected",
      stopped: transport.status(session).lifecycle === "stopped",
      restartError,
      trackStateBeforeCleanup: stream.getVideoTracks()[0]?.readyState,
    });
  } catch (error) {
    window.__whipGateResult = Object.freeze({
      connected: false,
      stopped: false,
      errorCode: error && typeof error === "object" && "code" in error ? String(error.code) : "live_gate_failed",
    });
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
});

export {};
