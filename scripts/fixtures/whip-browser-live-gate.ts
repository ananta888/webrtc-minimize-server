import { BroadcastPublicationRequest } from "../../frontend/src/app/broadcast/broadcast-ports";
import { Rfc9725WhipTransport } from "../../frontend/src/app/broadcast/whip-browser-transport";

declare global {
  interface Window {
    __WHIP_GATE_ENDPOINT__: string;
    __WHIP_GATE_TOKEN__?: string;
    __WHIP_GATE_HOLD_MS__?: number;
    __WHIP_GATE_SWITCHES__?: number;
    __WHIP_GATE_VIDEO_CODEC__?: string;
    __whipGateConnected?: boolean;
    __whipGateResult?: Readonly<Record<string, unknown>>;
  }
}

const button = document.querySelector<HTMLButtonElement>("#run-whip-gate");
if (!button) throw new Error("live_gate_button_missing");

button.addEventListener("click", async () => {
  button.disabled = true;
  const sources: Array<Readonly<{ stream: MediaStream; animation: ReturnType<typeof setInterval> }>> = [];
  const mediaByComposition = new Map<string, Readonly<{
    stream: MediaStream;
    tracks: readonly Readonly<{
      sourceId: string;
      sourceKind: "camera" | "screen" | "slate";
      envelope: "clear-program-v1";
      track: MediaStreamTrack;
    }>[];
  }>>();
  const createSource = (index: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("live_gate_canvas_unavailable");
    let frame = 0;
    const draw = () => {
      frame += 1;
      context.fillStyle = index % 2 === 0 ? "#32d3a4" : "#3377dd";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#ffffff";
      context.fillRect((frame * 7) % 280, 70, 40, 40);
    };
    draw();
    const animation = setInterval(draw, 50);
    const stream = canvas.captureStream(10);
    sources.push({ stream, animation });
    const sourceId = `src_${String(index).padStart(16, "0")}`;
    const compositionId = `composition-live-gate-${index}`;
    const sourceKind = index % 3 === 1 ? "screen" : index % 3 === 2 ? "slate" : "camera";
    const media = Object.freeze({
      stream,
      tracks: Object.freeze([Object.freeze({
        sourceId,
        sourceKind,
        envelope: "clear-program-v1" as const,
        track: stream.getVideoTracks()[0],
      })]),
    });
    mediaByComposition.set(compositionId, media);
    return { compositionId, sourceId, media };
  };
  const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const initial = createSource(0);
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
      compositionId: initial.compositionId,
      sourceIds: [initial.sourceId],
    },
  };
  const transport = new Rfc9725WhipTransport({
    configurationVersion: 1,
    compatibilityProfile: "mediamtx-1.20",
    endpointUrl: window.__WHIP_GATE_ENDPOINT__,
    allowedRedirectOrigins: [],
    iceServers: [],
    codecPreferences: { audio: [], video: [window.__WHIP_GATE_VIDEO_CODEC__ || "video/vp8"] },
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
    media: {
      resolve: async (composition) => {
        const media = mediaByComposition.get(composition.compositionId);
        if (!media) throw new Error("live_gate_composition_missing");
        return media;
      },
    },
    authorization: {
      authorize: async () => ({
        authorizationVersion: 1,
        accessToken: window.__WHIP_GATE_TOKEN__ || "live-gate:live-password",
        expiresAt: Date.now() + 60_000,
      }),
    },
    scheduleAdaptation: false,
  });
  try {
    const session = await transport.start(request, new AbortController().signal);
    const connected = transport.status(session);
    window.__whipGateConnected = connected.lifecycle === "connected";
    if (window.__WHIP_GATE_HOLD_MS__) await wait(window.__WHIP_GATE_HOLD_MS__);
    const encodedFrames: number[] = [];
    await wait(700);
    await transport.sampleStats(session);
    await wait(700);
    encodedFrames.push((await transport.sampleStats(session)).framesEncodedDelta || 0);
    const switches = window.__WHIP_GATE_SWITCHES__ ?? 4;
    for (let index = 1; index <= switches; index += 1) {
      const replacement = createSource(index);
      await transport.replaceComposition(session, {
        compositionId: replacement.compositionId,
        sourceIds: [replacement.sourceId],
      }, new AbortController().signal);
      await wait(700);
      await transport.sampleStats(session);
      await wait(700);
      encodedFrames.push((await transport.sampleStats(session)).framesEncodedDelta || 0);
      sources[index - 1].stream.getTracks().forEach((track) => track.stop());
    }
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
      switches,
      minimumFramesAfterSwitch: encodedFrames.length ? Math.min(...encodedFrames) : 0,
      trackStateBeforeCleanup: sources.at(-1)?.stream.getVideoTracks()[0]?.readyState,
    });
  } catch (error) {
    window.__whipGateResult = Object.freeze({
      connected: false,
      stopped: false,
      errorCode: error && typeof error === "object" && "code" in error ? String(error.code) : "live_gate_failed",
    });
  } finally {
    for (const source of sources) {
      clearInterval(source.animation);
      source.stream.getTracks().forEach((track) => track.stop());
    }
  }
});

export {};
