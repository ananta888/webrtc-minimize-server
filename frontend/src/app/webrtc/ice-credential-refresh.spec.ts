import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ICE_CREDENTIAL_SAFETY_MARGIN_MS,
  ICE_REFRESH_COALESCE_MS,
  ICE_REFRESH_PATH,
  ICE_REFRESH_RETRY_BASE_MS,
  IceCredentialRefresher,
  IcePolicySource,
  parseIceRefreshGrant,
} from "./ice-credential-refresher";
import { IceTierPolicy } from "./ice-policy";
import { ICE_RECOVERY_BASE_MS, PeerConnectionManager } from "./peer-connection-manager";
import { RoomSessionService } from "./room-session.service";

const TOKEN = "t".repeat(43);

function policyWith(username: string): IceTierPolicy {
  return {
    version: 1,
    directIceServers: [{ urls: "stun:direct.test" }],
    peerRelayIceServers: [],
    infrastructureRelayIceServers: [{ urls: "turn:infra.test", username, credential: "c-" + username, credentialType: "password" }],
    peerRelayAfterMs: 4_000,
    infrastructureRelayAfterMs: 9_000,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  configuration: RTCConfiguration;
  readonly configurations: RTCConfiguration[] = [];
  restarts = 0;
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onicecandidate: RTCPeerConnection["onicecandidate"] = null;
  ontrack: RTCPeerConnection["ontrack"] = null;
  ondatachannel: RTCPeerConnection["ondatachannel"] = null;
  oniceconnectionstatechange: RTCPeerConnection["oniceconnectionstatechange"] = null;
  onconnectionstatechange: RTCPeerConnection["onconnectionstatechange"] = null;
  onnegotiationneeded: RTCPeerConnection["onnegotiationneeded"] = null;

  constructor(configuration: RTCConfiguration) {
    this.configuration = configuration;
    FakePeerConnection.instances.push(this);
  }

  setConfiguration(configuration: RTCConfiguration): void {
    this.configuration = configuration;
    this.configurations.push(configuration);
  }
  getConfiguration(): RTCConfiguration { return this.configuration; }
  getTransceivers(): RTCRtpTransceiver[] { return []; }
  createDataChannel(label: string): RTCDataChannel { return { label, close: vi.fn() } as unknown as RTCDataChannel; }
  restartIce(): void { this.restarts += 1; }
  async getStats(): Promise<RTCStatsReport> { return new Map() as unknown as RTCStatsReport; }
  async setLocalDescription(): Promise<void> { throw new DOMException("fixture", "OperationError"); }
  close(): void { this.connectionState = "closed"; this.iceConnectionState = "closed"; }
}

function turnUsernames(configuration: RTCConfiguration): string[] {
  return (configuration.iceServers ?? []).flatMap((server) => server.username ? [server.username] : []);
}

describe("ICE refresh grant contract", () => {
  it("accepts only the server route, a 43-character token and an integer expiry", () => {
    expect(parseIceRefreshGrant({ path: ICE_REFRESH_PATH, token: TOKEN, expiresAt: 1_000 }))
      .toEqual({ path: ICE_REFRESH_PATH, token: TOKEN, expiresAt: 1_000 });
    expect(parseIceRefreshGrant({ path: "https://evil.test/steal", token: TOKEN, expiresAt: 1 })).toBeNull();
    expect(parseIceRefreshGrant({ path: ICE_REFRESH_PATH, token: "short", expiresAt: 1 })).toBeNull();
    expect(parseIceRefreshGrant({ path: ICE_REFRESH_PATH, token: TOKEN, expiresAt: 1.5 })).toBeNull();
    expect(parseIceRefreshGrant({ path: ICE_REFRESH_PATH, token: TOKEN, expiresAt: 1, extra: true })).toBeNull();
  });
});

describe("IceCredentialRefresher", () => {
  let now = 0;
  const logs: Array<{ event: string; detail: Record<string, unknown> }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    logs.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  function refresher(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, expiresAt = now + 600_000) {
    return new IceCredentialRefresher(policyWith("initial"), { path: ICE_REFRESH_PATH, token: TOKEN, expiresAt }, {
      fetch: vi.fn(fetchImpl) as unknown as typeof fetch,
      now: () => now,
      log: (event, detail) => logs.push({ event, detail }),
    });
  }

  it("fetches fresh credentials without cache and coalesces concurrent and immediate callers", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { icePolicy: policyWith("fresh"), expiresAt: now + 600_000 }));
    const source = refresher(fetchImpl);
    now += ICE_REFRESH_COALESCE_MS;
    const [first, second] = await Promise.all([source.refresh("tier-2"), source.refresh("tier-2")]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(ICE_REFRESH_PATH);
    expect(init).toMatchObject({ method: "POST", cache: "no-store", credentials: "same-origin", redirect: "error" });
    expect(JSON.parse(String(init.body))).toEqual({ refreshToken: TOKEN });
    expect(turnUsernames({ iceServers: [...first!.infrastructureRelayIceServers] })).toEqual(["fresh"]);
    expect(second).toBe(first);
    expect(source.current()).toBe(first);
    // Right after a fetch the same credentials serve the next tier step.
    await source.refresh("tier-2");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it("never hands out expired credentials when the refresh fails, and backs off", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("network down"); });
    const source = refresher(fetchImpl, now + 60_000);
    now += ICE_REFRESH_COALESCE_MS;
    expect(await source.refresh("tier-2")).toBe(source.current());
    expect(logs.at(-1)).toMatchObject({ event: "refresh-failed", detail: { reason: "tier-2", usable: true, failures: 1 } });
    now += 60_000 - ICE_CREDENTIAL_SAFETY_MARGIN_MS;
    expect(await source.refresh("recovery")).toBeNull();
    expect(logs.at(-1)).toMatchObject({ event: "refresh-failed", detail: { usable: false, failures: 2 } });
    // The background retry doubles per failure instead of looping.
    source.start();
    fetchImpl.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ICE_REFRESH_RETRY_BASE_MS * 4 - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    source.stop();
  });

  it("stops asking once the server revoked the membership-bound grant", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "invalid_ice_refresh" }));
    const source = refresher(fetchImpl);
    source.start();
    now += ICE_REFRESH_COALESCE_MS;
    await source.refresh("tier-1");
    expect(logs.at(-1)).toMatchObject({ event: "refresh-failed", detail: { status: 401, code: "invalid_ice_refresh", revoked: true } });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchImpl).toHaveBeenCalledOnce();
    source.stop();
  });

  it("refreshes proactively at half the remaining lifetime", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { icePolicy: policyWith("proactive"), expiresAt: now + 600_000 }));
    const source = refresher(fetchImpl);
    source.start();
    const halfLife = (600_000 - ICE_CREDENTIAL_SAFETY_MARGIN_MS) / 2;
    await vi.advanceTimersByTimeAsync(halfLife - 1);
    expect(fetchImpl).not.toHaveBeenCalled();
    now += halfLife;
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(turnUsernames({ iceServers: [...source.current().infrastructureRelayIceServers] })).toEqual(["proactive"]);
    source.stop();
  });
});

describe("PeerConnectionManager with refreshable TURN credentials", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakePeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function source(results: Array<IceTierPolicy | null>): IcePolicySource & { refresh: ReturnType<typeof vi.fn> } {
    let current = policyWith("stale");
    return {
      current: () => current,
      refresh: vi.fn(async () => {
        const next = results.length > 1 ? results.shift()! : results[0];
        if (next) current = next;
        return next;
      }),
    };
  }

  function manager(ice: IcePolicySource, negotiationErrors: unknown[] = []) {
    return new PeerConnectionManager("ffffffffffffffff", ice, false, {
      signal: () => undefined,
      track: () => undefined,
      channel: () => undefined,
      state: () => undefined,
      negotiationError: (_peer, error) => negotiationErrors.push(error),
    });
  }

  it("creates the connection on direct STUN and fetches credentials right before the relay tier", async () => {
    const ice = source([policyWith("fresh-1")]);
    const connections = manager(ice);
    const peer = connections.add("0000000000000001", "Ada")!;
    const pc = peer.pc as unknown as FakePeerConnection;
    expect(turnUsernames(pc.configuration)).toEqual([]);
    expect(ice.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(ice.refresh).toHaveBeenCalledWith("tier-2");
    expect(peer.iceTier).toBe(2);
    expect(turnUsernames(pc.configuration)).toEqual(["fresh-1"]);
    expect(pc.restarts).toBe(1);
    connections.close();
  });

  it("does not start a relay tier with credentials it could not refresh, then recovers with backoff", async () => {
    const ice = source([null, null, policyWith("fresh-2")]);
    const connections = manager(ice);
    const peer = connections.add("0000000000000001", "Ada")!;
    const pc = peer.pc as unknown as FakePeerConnection;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(peer.iceTier).toBe(2);
    expect(pc.configurations).toEqual([]);
    expect(pc.restarts).toBe(0);

    // First recovery: still no credentials, nothing applied, next attempt waits twice as long.
    await vi.advanceTimersByTimeAsync(ICE_RECOVERY_BASE_MS);
    expect(ice.refresh).toHaveBeenCalledTimes(2);
    expect(pc.configurations).toEqual([]);
    await vi.advanceTimersByTimeAsync(ICE_RECOVERY_BASE_MS * 2 - 1);
    expect(ice.refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(ice.refresh).toHaveBeenCalledTimes(3);
    expect(turnUsernames(pc.configuration)).toEqual(["fresh-2"]);
    expect(pc.restarts).toBe(1);

    // Connected: the watchdog stops and nothing restarts any more.
    pc.connectionState = "connected";
    pc.iceConnectionState = "connected";
    pc.onconnectionstatechange?.(new Event("connectionstatechange"));
    await vi.advanceTimersByTimeAsync(ICE_RECOVERY_BASE_MS * 20);
    expect(ice.refresh).toHaveBeenCalledTimes(3);
    expect(pc.restarts).toBe(1);
    connections.close();
  });

  it("restarts a peer stuck on its last tier with fresh credentials each time, bounded by the backoff cap", async () => {
    let serial = 0;
    const ice: IcePolicySource & { refresh: ReturnType<typeof vi.fn> } = {
      current: () => policyWith("current"),
      refresh: vi.fn(async () => policyWith("fresh-" + ++serial)),
    };
    const connections = manager(ice);
    const peer = connections.add("0000000000000001", "Ada")!;
    const pc = peer.pc as unknown as FakePeerConnection;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(pc.restarts).toBe(1);
    // Stuck in "new": 10 s, 20 s, 40 s, 80 s, then at most every 120 s.
    await vi.advanceTimersByTimeAsync(10_000 + 20_000 + 40_000 + 80_000);
    expect(pc.restarts).toBe(5);
    await vi.advanceTimersByTimeAsync(120_000 * 3);
    expect(pc.restarts).toBe(8);
    expect(turnUsernames(pc.configuration)).toEqual(["fresh-" + serial]);
    expect(new Set(pc.configurations.map((configuration) => turnUsernames(configuration)[0])).size)
      .toBe(pc.configurations.length);
    connections.close();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(pc.restarts).toBe(8);
  });

  it("arms a recovery after a failed negotiation on the last tier", async () => {
    const ice = source([policyWith("fresh-3")]);
    const errors: unknown[] = [];
    const connections = manager(ice, errors);
    const peer = connections.add("0000000000000001", "Ada")!;
    const pc = peer.pc as unknown as FakePeerConnection;
    await vi.advanceTimersByTimeAsync(9_000);
    pc.connectionState = "connected";
    pc.iceConnectionState = "connected";
    pc.onconnectionstatechange?.(new Event("connectionstatechange"));
    // Transport dropped silently, then a renegotiation fails.
    pc.connectionState = "connecting";
    pc.iceConnectionState = "checking";
    const restartsBefore = pc.restarts;
    pc.onnegotiationneeded?.(new Event("negotiationneeded"));
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ICE_RECOVERY_BASE_MS - 1);
    expect(pc.restarts).toBe(restartsBefore);
    await vi.advanceTimersByTimeAsync(1);
    expect(pc.restarts).toBe(restartsBefore + 1);
    connections.close();
  });
});

describe("RoomSessionService ICE credential refresh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches fresh credentials through the session grant and stops with the session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === ICE_REFRESH_PATH
      ? jsonResponse(200, { icePolicy: policyWith("refreshed"), expiresAt: Date.now() + 600_000 })
      : jsonResponse(201, {
        signalingPath: "/signal?ticket=x",
        iceServers: [],
        icePolicy: policyWith("admitted"),
        iceRefresh: { path: ICE_REFRESH_PATH, token: TOKEN, expiresAt: Date.now() + 600_000 },
        identity: { authenticated: false },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const signaling = { leave: vi.fn(), connect: vi.fn() };
    const service = new RoomSessionService(
      { value: () => ({ maxRoomParticipants: 20, mediaE2ee: { mode: "required" } }) } as never,
      { authorizationHeader: () => ({}) } as never,
      { createProof: async () => ({}) } as never,
      signaling as never,
      { close: vi.fn() } as never,
    );
    await service.join("room-alpha", "Ada", "room");
    expect(signaling.connect).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(ICE_REFRESH_COALESCE_MS);
    const fresh = await service.freshIcePolicy("test");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(ICE_REFRESH_PATH);
    expect(fetchMock.mock.calls[1]).toMatchObject([ICE_REFRESH_PATH, { cache: "no-store" }]);
    expect(fresh?.infrastructureRelayIceServers[0].username).toBe("refreshed");
    expect(service.icePolicy()?.infrastructureRelayIceServers[0].username).toBe("refreshed");

    service.leave();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await service.freshIcePolicy("after-leave")).toBeNull();
  });
});
