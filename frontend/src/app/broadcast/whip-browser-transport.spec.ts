import { describe, expect, it, vi } from "vitest";

import { BroadcastPublicationRequest } from "./broadcast-ports";
import { Rfc9725WhipTransport, WhipPeerConnectionFactory } from "./whip-browser-transport";
import {
  WhipAction,
  WhipAuthorizationPort,
  WhipMediaStreamPort,
  WhipRuntimeConfiguration,
} from "./whip-contracts";

const OFFER = [
  "v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0",
  "m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0", "a=ice-ufrag:localA",
  "a=ice-pwd:abcdefghijklmnopqrstuvwx", "a=setup:actpass", "a=mid:0",
  "a=sendonly", "a=msid:program-stream video-track", "a=rtcp-mux", "a=rtpmap:96 VP8/90000", "",
].join("\r\n");

const RESTART_OFFER = OFFER.replace("localA", "localB").replace(
  "abcdefghijklmnopqrstuvwx", "bcdefghijklmnopqrstuvwxy",
);

const AUDIO_OFFER = OFFER
  .replace("m=video 9 UDP/TLS/RTP/SAVPF 96", "m=audio 9 UDP/TLS/RTP/SAVPF 111")
  .replace("a=msid:program-stream video-track", "a=msid:program-stream audio-track")
  .replace("a=rtpmap:96 VP8/90000", "a=rtpmap:111 opus/48000/2");

const ANSWER = [
  "v=0", "o=- 2 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0",
  "m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0", "a=ice-ufrag:remoteA",
  "a=ice-pwd:zyxwvutsrqponmlkjihgfedc", "a=setup:passive", "a=mid:0",
  "a=recvonly", "a=rtcp-mux", "a=rtcp-mux-only", "a=rtpmap:96 VP8/90000", "",
].join("\r\n");

const AUDIO_ANSWER = ANSWER
  .replace("m=video 9 UDP/TLS/RTP/SAVPF 96", "m=audio 9 UDP/TLS/RTP/SAVPF 111")
  .replace("a=rtpmap:96 VP8/90000", "a=rtpmap:111 opus/48000/2");

const RESTART_FRAGMENT = [
  "a=group:BUNDLE 0", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:0",
  "a=ice-ufrag:remoteB", "a=ice-pwd:abcdefghijklmnopqrstuvwx",
  "a=candidate:2 1 udp 1 198.51.100.2 50000 typ host", "a=end-of-candidates", "",
].join("\r\n");

const NOW = 1_800_000_000_000;

function request(): BroadcastPublicationRequest {
  return {
    requestVersion: 1,
    program: {
      tenantId: "tn_aaaaaaaaaaaaaaaa",
      roomId: "room-alpha",
      programId: "prg_aaaaaaaaaaaaaaaa",
      programRevision: 4,
      programEpoch: 7,
    },
    composition: { compositionId: "composition-1", sourceIds: ["src_aaaaaaaaaaaaaaaa"] },
  };
}

function fakeTrack(kind: "audio" | "video"): MediaStreamTrack {
  return Object.assign(new EventTarget(), { kind, readyState: "live", contentHint: "" }) as MediaStreamTrack;
}

function resolvedMedia(
  descriptors: readonly Readonly<{
    sourceId: string;
    sourceKind: "microphone" | "camera" | "screen" | "screen-audio" | "silence" | "slate";
    track: MediaStreamTrack;
  }>[],
) {
  return {
    stream: { getTracks: () => descriptors.map(({ track }) => track) } as unknown as MediaStream,
    tracks: descriptors.map((descriptor) => ({ ...descriptor, envelope: "clear-program-v1" as const })),
  };
}

function configuration(overrides: Partial<WhipRuntimeConfiguration> = {}): WhipRuntimeConfiguration {
  return {
    configurationVersion: 1,
    compatibilityProfile: "rfc9725",
    endpointUrl: "https://media.example.test/live/whip",
    allowedRedirectOrigins: ["https://edge.example.test"],
    iceServers: [{ urls: ["stun:stun.example.test"] }],
    codecPreferences: { audio: ["audio/opus"], video: ["video/vp8"] },
    simulcast: { enabled: false, sendEncodings: [] },
    trickleIce: true,
    requestTimeoutMs: 1_000,
    iceGatheringTimeoutMs: 1_000,
    connectionTimeoutMs: 1_000,
    maximumResponseBytes: 128 * 1024,
    maximumSdpBytes: 64 * 1024,
    maximumIceFragmentBytes: 8 * 1024,
    maximumCandidates: 16,
    retryBudget: 1,
    ...overrides,
  };
}

class FakePeerConnection extends EventTarget {
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  iceGatheringState: RTCIceGatheringState = "new";
  connectionState: RTCPeerConnectionState = "new";
  readonly setCodecPreferences = vi.fn();
  readonly close = vi.fn(() => {
    this.connectionState = "closed";
  });
  readonly restartIce = vi.fn();
  readonly senders: Array<RTCRtpSender & { replacedTrack: MediaStreamTrack }> = [];
  readonly transceiverInits: RTCRtpTransceiverInit[] = [];
  private restart = false;
  private statsTick = 0;

  addTransceiver(_track: MediaStreamTrack, init?: RTCRtpTransceiverInit): RTCRtpTransceiver {
    expect(init?.direction).toBe("sendonly");
    expect(init?.streams).toHaveLength(1);
    let replacedTrack = _track;
    this.transceiverInits.push({
      ...init,
      streams: init?.streams ? [...init.streams] : undefined,
      sendEncodings: init?.sendEncodings?.map((encoding) => ({ ...encoding })),
    });
    let parameters = {
      encodings: init?.sendEncodings?.map((encoding) => ({ ...encoding })) || [{}],
    } as RTCRtpSendParameters;
    const sender = {
      get replacedTrack() { return replacedTrack; },
      getParameters: vi.fn(() => structuredClone(parameters)),
      setParameters: vi.fn(async (next: RTCRtpSendParameters) => { parameters = structuredClone(next); }),
      replaceTrack: vi.fn(async (next: MediaStreamTrack | null) => {
        if (next) replacedTrack = next;
      }),
    } as unknown as RTCRtpSender & { replacedTrack: MediaStreamTrack };
    this.senders.push(sender);
    return { sender, setCodecPreferences: this.setCodecPreferences } as unknown as RTCRtpTransceiver;
  }

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.restart = options?.iceRestart === true;
    const audioOnly = this.senders.length === 1 && this.senders[0].replacedTrack.kind === "audio";
    return { type: "offer", sdp: this.restart ? RESTART_OFFER : audioOnly ? AUDIO_OFFER : OFFER };
  }

  async setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
    this.iceGatheringState = "gathering";
    queueMicrotask(() => {
      const candidate = {
        toJSON: () => ({
          candidate: "candidate:1 1 udp 2122260223 192.0.2.1 61764 typ host",
          sdpMid: "0",
          sdpMLineIndex: 0,
        }),
      } as RTCIceCandidate;
      this.dispatchEvent(Object.assign(new Event("icecandidate"), { candidate }));
      this.dispatchEvent(Object.assign(new Event("icecandidate"), { candidate: null }));
      this.iceGatheringState = "complete";
      this.dispatchEvent(new Event("icegatheringstatechange"));
    });
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
    this.connectionState = "connected";
    this.dispatchEvent(new Event("connectionstatechange"));
  }

  async getStats(): Promise<RTCStatsReport> {
    this.statsTick += 1;
    return new Map([
      ["outbound", {
        type: "outbound-rtp",
        kind: this.senders[0]?.replacedTrack.kind || "video",
        bytesSent: this.statsTick * 100_000,
        packetsSent: this.statsTick * 100,
        framesEncoded: this.statsTick * 20,
        totalEncodeTime: this.statsTick * 0.2,
      }],
      ["remote", { type: "remote-inbound-rtp", packetsLost: 0, roundTripTime: 0.05 }],
      ["pair", {
        type: "candidate-pair", selected: true, state: "succeeded", availableOutgoingBitrate: 5_000_000,
      }],
    ]) as unknown as RTCStatsReport;
  }
}

function response(body: string | null, init: ResponseInit, url = ""): Response {
  const result = new Response(body, init);
  if (url) Object.defineProperty(result, "url", { value: url });
  return result;
}

function created(url = "", answer = ANSWER): Response {
  return response(answer, {
    status: 201,
    headers: {
      "content-type": "application/sdp",
      "content-length": String(new TextEncoder().encode(answer).byteLength),
      location: "/live/session/opaque-resource",
      etag: '"ice-1"',
    },
  }, url);
}

function fixture(
  fetchResponses: readonly Response[] | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>),
  configurationOverrides: Partial<WhipRuntimeConfiguration> = {},
) {
  let currentNow = NOW;
  const peer = new FakePeerConnection();
  const peers = [peer];
  let peerConnectionCount = 0;
  const peerConnections: WhipPeerConnectionFactory = {
    create: vi.fn(() => {
      if (peerConnectionCount === 0) {
        peerConnectionCount += 1;
        return peer as unknown as RTCPeerConnection;
      }
      const next = new FakePeerConnection();
      peers.push(next);
      peerConnectionCount += 1;
      return next as unknown as RTCPeerConnection;
    }),
    capabilities: vi.fn((kind) => ({
      codecs: [kind === "audio"
        ? { mimeType: "audio/opus", clockRate: 48_000, channels: 2 }
        : { mimeType: "video/VP8", clockRate: 90_000 }],
      headerExtensions: [],
    })),
  };
  const track = fakeTrack("video");
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream;
  const media: WhipMediaStreamPort = {
    resolve: vi.fn(async () => ({
      stream,
      tracks: [{
        sourceId: "src_aaaaaaaaaaaaaaaa",
        sourceKind: "camera",
        envelope: "clear-program-v1",
        track,
      }],
    })),
  };
  const authorizations: Array<{ action: WhipAction; resourceUrl: string }> = [];
  const authorization: WhipAuthorizationPort = {
    authorize: vi.fn(async (input) => {
      authorizations.push({ action: input.action, resourceUrl: input.resourceUrl });
      return {
        authorizationVersion: 1,
        accessToken: `grant-${input.action}-abcdefghijklmnop`,
        expiresAt: currentNow + 60_000,
      };
    }),
  };
  const queue = Array.isArray(fetchResponses) ? [...fetchResponses] : null;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (queue) {
      const next = queue.shift();
      if (!next) throw new Error("unexpected_fetch");
      return next;
    }
    return fetchResponses(input, init);
  });
  const delay = vi.fn(async () => undefined);
  const transport = new Rfc9725WhipTransport(configuration(configurationOverrides), {
    authorization,
    media,
    peerConnections,
    fetch: fetchMock as unknown as typeof fetch,
    now: () => currentNow,
    delay,
    scheduleAdaptation: false,
  });
  return {
    transport,
    peer,
    peers,
    peerConnections,
    media,
    authorization,
    authorizations,
    fetchMock,
    delay,
    advanceNow: (milliseconds: number) => { currentNow += milliseconds; },
  };
}

describe("Rfc9725WhipTransport", () => {
  it("creates, trickles and idempotently deletes one bounded send-only WHIP session", async () => {
    const context = fixture([
      created(),
      response(null, { status: 204 }),
      response(null, { status: 200 }),
    ]);
    const signal = new AbortController().signal;
    const session = await context.transport.start(request(), signal);
    expect(await context.transport.start(request(), signal)).toBe(session);
    expect(context.transport.status(session)).toEqual({
      lifecycle: "connected", errorCode: "", restartAttempts: 0,
      qualityLevel: "high", adaptationReason: "initial-profile",
    });
    expect(context.fetchMock).toHaveBeenCalledTimes(2);
    const [postUrl, postInit] = context.fetchMock.mock.calls[0];
    expect(postUrl).toBe("https://media.example.test/live/whip");
    expect(postInit?.method).toBe("POST");
    expect(new Headers(postInit?.headers).get("content-type")).toBe("application/sdp");
    expect(new Headers(postInit?.headers).get("authorization")).toMatch(/^Bearer grant-whip:create-/);
    expect(String(postInit?.body)).toContain("a=rtcp-mux-only");
    expect(postInit?.credentials).toBe("omit");
    expect(postInit?.redirect).toBe("follow");
    expect(postInit?.referrerPolicy).toBe("no-referrer");
    const [, patchInit] = context.fetchMock.mock.calls[1];
    expect(patchInit?.method).toBe("PATCH");
    expect(new Headers(patchInit?.headers).get("if-match")).toBe('"ice-1"');
    expect(String(patchInit?.body)).toContain("a=end-of-candidates");
    expect(context.authorizations.map(({ action }) => action)).toEqual(["whip:create", "whip:update"]);
    await Promise.all([context.transport.stop(session, signal), context.transport.stop(session, signal)]);
    await context.transport.stop(session, signal);
    expect(context.fetchMock).toHaveBeenCalledTimes(3);
    expect(context.fetchMock.mock.calls[2][1]?.method).toBe("DELETE");
    expect(context.peer.close).toHaveBeenCalledOnce();
    expect(context.transport.status(session).lifecycle).toBe("stopped");
  });

  it("uses If-Match star for a bounded ICE restart and reports a network drop", async () => {
    const context = fixture([
      created(), response(null, { status: 204 }),
      response(RESTART_FRAGMENT, {
        status: 200,
        headers: { "content-type": "application/trickle-ice-sdpfrag", etag: '"ice-2"' },
      }),
      response(null, { status: 200 }),
    ]);
    const signal = new AbortController().signal;
    const session = await context.transport.start(request(), signal);
    context.peer.connectionState = "disconnected";
    context.peer.dispatchEvent(new Event("connectionstatechange"));
    expect(context.transport.status(session).lifecycle).toBe("degraded");
    await context.transport.restartIce(session, signal);
    const [, restartInit] = context.fetchMock.mock.calls[2];
    expect(restartInit?.method).toBe("PATCH");
    expect(new Headers(restartInit?.headers).get("if-match")).toBe("*");
    expect(context.peer.restartIce).toHaveBeenCalledOnce();
    expect(context.peer.remoteDescription?.sdp).toContain("a=ice-ufrag:remoteB");
    expect(context.transport.status(session)).toEqual({
      lifecycle: "connected", errorCode: "", restartAttempts: 1,
      qualityLevel: "high", adaptationReason: "initial-profile",
    });
    await context.transport.stop(session, signal);
  });

  it("retries only explicit overload responses with a fresh action grant", async () => {
    const context = fixture([
      response(null, { status: 503, headers: { "retry-after": "1" } }),
      created(), response(null, { status: 204 }), response(null, { status: 200 }),
    ]);
    const signal = new AbortController().signal;
    const session = await context.transport.start(request(), signal);
    expect(context.delay).toHaveBeenCalledWith(1_000, signal);
    expect(context.authorizations.map(({ action }) => action)).toEqual([
      "whip:create", "whip:create", "whip:update",
    ]);
    await context.transport.stop(session, signal);
  });

  it("accepts a followed same-origin redirect but rejects unsafe or untrusted redirect results", async () => {
    const redirected = fixture([
      created("https://media.example.test/region-a/whip"),
      response(null, { status: 204 }),
      response(null, { status: 200 }),
    ]);
    const signal = new AbortController().signal;
    const session = await redirected.transport.start(request(), signal);
    expect(redirected.authorizations[1]).toEqual({
      action: "whip:update",
      resourceUrl: "https://media.example.test/live/session/opaque-resource",
    });
    await redirected.transport.stop(session, signal);

    await expect(fixture([response(null, {
      status: 302,
      headers: { location: "https://media.example.test/legacy" },
    })]).transport.start(request(), signal)).rejects.toThrow("whip_unsafe_redirect");

    await expect(fixture([created("https://evil.example.test/live/whip")]).transport.start(
      request(), signal,
    )).rejects.toThrow("invalid_whip_resource_url");
  });

  it("isolates pinned MediaMTX 1.20 deviations and disables unsafe ICE restart", async () => {
    const mediaMtxAnswer = ANSWER.replace("a=rtcp-mux-only\r\n", "");
    const context = fixture([
      response(mediaMtxAnswer, {
        status: 201,
        headers: {
          "content-type": "application/sdp",
          location: "/live/session/opaque-resource",
          etag: "*",
        },
      }),
      response(null, { status: 204 }),
      response(null, { status: 200 }),
    ], { compatibilityProfile: "mediamtx-1.20" });
    const signal = new AbortController().signal;
    const session = await context.transport.start(request(), signal);
    expect(new Headers(context.fetchMock.mock.calls[1][1]?.headers).get("if-match")).toBe("*");
    await expect(context.transport.restartIce(session, signal)).rejects.toThrow("whip_ice_restart_unsupported");
    await context.transport.stop(session, signal);
  });

  it("uses only capability-checked runtime simulcast encodings and preserves their hard ceilings", async () => {
    const sendEncodings = [
      { rid: "q", active: true, maxBitrate: 120_000, maxFramerate: 6, scaleResolutionDownBy: 4 },
      { rid: "h", active: true, maxBitrate: 420_000, maxFramerate: 15, scaleResolutionDownBy: 2 },
      { rid: "f", active: true, maxBitrate: 1_200_000, maxFramerate: 24, scaleResolutionDownBy: 1 },
    ];
    const context = fixture([
      created(), response(null, { status: 204 }), response(null, { status: 200 }),
    ], { simulcast: { enabled: true, sendEncodings } });
    const signal = new AbortController().signal;
    const session = await context.transport.start(request(), signal);
    expect(context.peer.transceiverInits[0].sendEncodings).toEqual(sendEncodings);
    const applied = context.peer.senders[0].getParameters().encodings;
    expect(applied.map(({ rid, scaleResolutionDownBy }) => ({ rid, scaleResolutionDownBy })))
      .toEqual(sendEncodings.map(({ rid, scaleResolutionDownBy }) => ({ rid, scaleResolutionDownBy })));
    expect(applied.reduce((sum, encoding) => sum + Number(encoding.maxBitrate || 0), 0)).toBeLessThanOrEqual(1_200_000);
    applied.forEach((encoding, index) => {
      expect(Number(encoding.maxBitrate)).toBeLessThanOrEqual(sendEncodings[index].maxBitrate);
      expect(Number(encoding.maxFramerate)).toBeLessThanOrEqual(sendEncodings[index].maxFramerate);
    });
    await context.transport.stop(session, signal);
  });

  it("replaces a compatible source without renegotiation and exposes source end until a slate replaces it", async () => {
    const context = fixture([created(), response(null, { status: 204 }), response(null, { status: 200 })]);
    const signal = new AbortController().signal;
    const session = await context.transport.start(request(), signal);
    const screen = fakeTrack("video");
    vi.mocked(context.media.resolve).mockResolvedValueOnce(resolvedMedia([{
      sourceId: "src_bbbbbbbbbbbbbbbb", sourceKind: "screen", track: screen,
    }]));
    const switched = await context.transport.replaceComposition(session, {
      compositionId: "composition-screen",
      sourceIds: ["src_bbbbbbbbbbbbbbbb"],
    }, signal);
    expect(switched).toBe(session);
    expect(context.fetchMock).toHaveBeenCalledTimes(2);
    expect(context.peer.senders[0].replacedTrack).toBe(screen);
    expect(context.transport.status(session)).toMatchObject({
      lifecycle: "connected", adaptationReason: "source-replaced",
    });
    screen.dispatchEvent(new Event("ended"));
    expect(context.transport.status(session)).toMatchObject({
      lifecycle: "degraded", errorCode: "whip_video_source_ended", adaptationReason: "source-ended",
    });

    const slate = fakeTrack("video");
    vi.mocked(context.media.resolve).mockResolvedValueOnce(resolvedMedia([{
      sourceId: "src_cccccccccccccccc", sourceKind: "slate", track: slate,
    }]));
    expect(await context.transport.replaceComposition(session, {
      compositionId: "composition-slate",
      sourceIds: ["src_cccccccccccccccc"],
    }, signal)).toBe(session);
    expect(context.transport.status(session)).toMatchObject({ lifecycle: "connected", errorCode: "" });
    await context.transport.stop(session, signal);
  });

  it("uses DELETE plus a fresh POST instead of changing negotiated media sections", async () => {
    const context = fixture([
      created(), response(null, { status: 204 }), response(null, { status: 200 }),
      created("", AUDIO_ANSWER), response(null, { status: 204 }), response(null, { status: 200 }),
    ]);
    const signal = new AbortController().signal;
    const session = await context.transport.start(request(), signal);
    const audio = fakeTrack("audio");
    const audioMedia = resolvedMedia([
      { sourceId: "src_bbbbbbbbbbbbbbbb", sourceKind: "microphone", track: audio },
    ]);
    vi.mocked(context.media.resolve)
      .mockResolvedValueOnce(audioMedia)
      .mockResolvedValueOnce(audioMedia);
    const restarted = await context.transport.replaceComposition(session, {
      compositionId: "composition-audio",
      sourceIds: ["src_bbbbbbbbbbbbbbbb"],
    }, signal);
    expect(restarted.sessionId).not.toBe(session.sessionId);
    expect(context.transport.status(session).lifecycle).toBe("stopped");
    expect(context.peers).toHaveLength(2);
    expect(context.peers[0].close).toHaveBeenCalledOnce();
    expect(context.peers[1].remoteDescription?.sdp).toContain("m=audio");
    expect(context.fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST", "PATCH", "DELETE", "POST", "PATCH",
    ]);
    await context.transport.stop(restarted, signal);
  });

  it("keeps encoding through 360 adaptation cycles, repeated source switches and one network interruption", async () => {
    const context = fixture([
      created(), response(null, { status: 204 }),
      response(RESTART_FRAGMENT, {
        status: 200,
        headers: { "content-type": "application/trickle-ice-sdpfrag", etag: '"ice-2"' },
      }),
      response(null, { status: 200 }),
    ]);
    const signal = new AbortController().signal;
    const session = await context.transport.start(request(), signal);
    let progressiveSamples = 0;
    for (let counter = 1; counter <= 360; counter += 1) {
      context.advanceNow(2_000);
      if (counter % 60 === 0) {
        const replacement = fakeTrack("video");
        const sourceId = `src_${String(counter).padStart(16, "0")}`;
        vi.mocked(context.media.resolve).mockResolvedValueOnce(resolvedMedia([{
          sourceId,
          sourceKind: counter % 120 === 0 ? "screen" : "camera",
          track: replacement,
        }]));
        await context.transport.replaceComposition(session, {
          compositionId: `composition-${counter}`,
          sourceIds: [sourceId],
        }, signal);
      }
      if (counter === 180) {
        context.peer.connectionState = "disconnected";
        context.peer.dispatchEvent(new Event("connectionstatechange"));
        expect(context.transport.status(session).lifecycle).toBe("degraded");
        await context.transport.restartIce(session, signal);
      }
      const sample = await context.transport.sampleStats(session);
      if (sample.framesEncodedDelta !== null) {
        expect(sample.framesEncodedDelta).toBeGreaterThan(0);
        progressiveSamples += 1;
      }
    }
    expect(progressiveSamples).toBeGreaterThan(350);
    expect(context.transport.status(session)).toMatchObject({
      lifecycle: "connected", restartAttempts: 1,
    });
    await context.transport.stop(session, signal);
    expect(context.peer.close).toHaveBeenCalledOnce();
  });

  it("fails closed on unauthorized, oversized and stale grant responses", async () => {
    await expect(fixture([response(null, { status: 401 })]).transport.start(
      request(), new AbortController().signal,
    )).rejects.toThrow("whip_unauthorized");

    const oversized = created();
    oversized.headers.set("content-length", String(512 * 1024));
    await expect(fixture([oversized]).transport.start(
      request(), new AbortController().signal,
    )).rejects.toThrow("whip_response_too_large");

    const context = fixture([created()]);
    vi.mocked(context.authorization.authorize).mockResolvedValueOnce({
      authorizationVersion: 1,
      accessToken: "expired-token-abcdefghijklmnop",
      expiresAt: NOW - 1,
    });
    await expect(context.transport.start(request(), new AbortController().signal))
      .rejects.toThrow("invalid_whip_authorization");
    expect(context.peer.close).toHaveBeenCalledOnce();
  });

  it("maps a hanging CORS/network request to a bounded timeout without exposing SDP or bearer data", async () => {
    const context = fixture((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const transport = new Rfc9725WhipTransport(configuration({ requestTimeoutMs: 1_000 }), {
      authorization: context.authorization,
      media: context.media,
      peerConnections: context.peerConnections,
      fetch: context.fetchMock as unknown as typeof fetch,
      now: () => NOW,
    });
    const error = await transport.start(request(), new AbortController().signal).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "whip_request_timeout" });
    expect(String(error)).not.toContain("v=0");
    expect(String(error)).not.toContain("grant-whip:create");
  });

  it("maps an opaque CORS response and a network rejection to bounded public error codes", async () => {
    const opaque = created();
    Object.defineProperty(opaque, "type", { value: "opaque" });
    await expect(fixture([opaque]).transport.start(request(), new AbortController().signal))
      .rejects.toThrow("whip_cors_response_blocked");
    await expect(fixture(async () => {
      throw new TypeError("browser deliberately hides CORS details");
    }).transport.start(request(), new AbortController().signal))
      .rejects.toThrow("whip_network_or_cors_error");
  });
});
