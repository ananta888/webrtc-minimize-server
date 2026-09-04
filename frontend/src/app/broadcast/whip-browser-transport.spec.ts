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

const ANSWER = [
  "v=0", "o=- 2 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0",
  "m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0", "a=ice-ufrag:remoteA",
  "a=ice-pwd:zyxwvutsrqponmlkjihgfedc", "a=setup:passive", "a=mid:0",
  "a=recvonly", "a=rtcp-mux", "a=rtcp-mux-only", "a=rtpmap:96 VP8/90000", "",
].join("\r\n");

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
  private restart = false;

  addTransceiver(_track: MediaStreamTrack, init?: RTCRtpTransceiverInit): RTCRtpTransceiver {
    expect(init?.direction).toBe("sendonly");
    expect(init?.streams).toHaveLength(1);
    return { setCodecPreferences: this.setCodecPreferences } as unknown as RTCRtpTransceiver;
  }

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.restart = options?.iceRestart === true;
    return { type: "offer", sdp: this.restart ? RESTART_OFFER : OFFER };
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
}

function response(body: string | null, init: ResponseInit, url = ""): Response {
  const result = new Response(body, init);
  if (url) Object.defineProperty(result, "url", { value: url });
  return result;
}

function created(url = ""): Response {
  return response(ANSWER, {
    status: 201,
    headers: {
      "content-type": "application/sdp",
      "content-length": String(new TextEncoder().encode(ANSWER).byteLength),
      location: "/live/session/opaque-resource",
      etag: '"ice-1"',
    },
  }, url);
}

function fixture(
  fetchResponses: readonly Response[] | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>),
  configurationOverrides: Partial<WhipRuntimeConfiguration> = {},
) {
  const peer = new FakePeerConnection();
  const peerConnections: WhipPeerConnectionFactory = {
    create: vi.fn(() => peer as unknown as RTCPeerConnection),
    capabilities: vi.fn(() => ({
      codecs: [{ mimeType: "video/VP8", clockRate: 90_000 }],
      headerExtensions: [],
    })),
  };
  const track = { kind: "video", readyState: "live" } as MediaStreamTrack;
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream;
  const media: WhipMediaStreamPort = { resolve: vi.fn(async () => stream) };
  const authorizations: Array<{ action: WhipAction; resourceUrl: string }> = [];
  const authorization: WhipAuthorizationPort = {
    authorize: vi.fn(async (input) => {
      authorizations.push({ action: input.action, resourceUrl: input.resourceUrl });
      return {
        authorizationVersion: 1,
        accessToken: `grant-${input.action}-abcdefghijklmnop`,
        expiresAt: NOW + 60_000,
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
    now: () => NOW,
    delay,
  });
  return { transport, peer, peerConnections, media, authorization, authorizations, fetchMock, delay };
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
