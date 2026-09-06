import { afterEach, describe, expect, it, vi } from "vitest";

import { BroadcastPlaybackGatewayService } from "./broadcast-playback-gateway.service";

describe("BroadcastPlaybackGatewayService", () => {
  afterEach(() => vi.restoreAllMocks());

  const resource = "res_aaaaaaaaaaaaaaaa";
  const sessionId = "pbs_aaaaaaaaaaaaaaaaaaaaaaaa";
  const reply = (id = sessionId, ref = resource) => new Response(JSON.stringify({ playbackSessionId: id,
    manifestUrl: `/broadcast/play/${ref}/index.m3u8`, expiresAt: Date.now() + 60_000 }), { status: 201 });

  it("serializes opens and cleans a late cancelled handle without touching its successor", async () => {
    let release!: (value: Response) => void;
    const delayed = new Promise<Response>((resolve) => { release = resolve; });
    const nextId = "pbs_bbbbbbbbbbbbbbbbbbbbbbbb", nextResource = "res_bbbbbbbbbbbbbbbb";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(delayed)
      .mockResolvedValueOnce(reply(nextId, nextResource)).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const service = new BroadcastPlaybackGatewayService();
    const pending = service.open(resource, "old-playback-grant", new AbortController().signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(DOMException);
    await expect(service.open(nextResource, "new-playback-grant", new AbortController().signal)).rejects.toThrow("gateway_busy");
    await service.close();
    const current = await service.open(nextResource, "new-playback-grant", new AbortController().signal);
    release(reply());
    await rejected;
    expect(service.session()).toBe(current);
    expect(fetchMock.mock.calls.at(-1)).toEqual([
      `/api/broadcast/playback-sessions/${sessionId}`, expect.objectContaining({ method: "DELETE", signal: expect.any(AbortSignal) }),
    ]);
  });

  it("cannot restore a closed session through a late renewal response", async () => {
    let release!: (value: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(reply())
      .mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const service = new BroadcastPlaybackGatewayService();
    await service.open(resource, "old-playback-grant", new AbortController().signal);
    const pending = service.renew(resource, "new-playback-grant", new AbortController().signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(DOMException);
    await expect(service.renew(resource, "new-playback-grant", new AbortController().signal)).rejects.toThrow("gateway_busy");
    await service.close();
    expect(service.session()).toBeNull();
    release(reply());
    await rejected;
    expect(service.session()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("clears local authority immediately, bounds DELETE and retains failed cleanup for explicit retry", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(reply())
      .mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const service = new BroadcastPlaybackGatewayService();
    await service.open(resource, "old-playback-grant", new AbortController().signal);
    const close = service.close();
    expect(service.session()).toBeNull();
    await expect(close).rejects.toThrow("offline");
    await expect(service.open(resource, "new-playback-grant", new AbortController().signal)).rejects.toThrow("gateway_busy");
    await service.close();
    expect(fetchMock.mock.calls.slice(1).every(([url]) => url === `/api/broadcast/playback-sessions/${sessionId}`)).toBe(true);
    expect(fetchMock.mock.calls[1][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects foreign resources and pre-aborted authorization without caching or sending credentials", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(reply(sessionId, "res_bbbbbbbbbbbbbbbb"));
    const service = new BroadcastPlaybackGatewayService();
    await expect(service.open(resource, "old-playback-grant", AbortSignal.abort())).rejects.toBeInstanceOf(DOMException);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(service.open(resource, "old-playback-grant", new AbortController().signal)).rejects.toThrow("invalid_broadcast_playback_gateway_response");
    expect(service.session()).toBeNull();
  });
  it("exchanges a bearer in a header and retains only the opaque playback session", async () => {
    const expiresAt = Date.now() + 60_000;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      playbackSessionId: "pbs_aaaaaaaaaaaaaaaaaaaaaaaa",
      manifestUrl: "/broadcast/play/res_aaaaaaaaaaaaaaaa/index.m3u8",
      expiresAt,
    }), { status: 201, headers: { "content-type": "application/json" } }));
    const service = new BroadcastPlaybackGatewayService();
    const session = await service.open("res_aaaaaaaaaaaaaaaa", "signed-playback-grant", new AbortController().signal);
    const request = fetchMock.mock.calls[0];
    expect(request[0]).toBe("/api/broadcast/playback-sessions");
    expect(request[1]?.headers).toEqual({ authorization: "Bearer signed-playback-grant", "content-type": "application/json" });
    expect(session.manifestUrl).not.toContain("grant");
    expect(JSON.stringify(service.session())).not.toContain("signed-playback-grant");
    fetchMock.mockRestore();
  });

  it("closes with the path cookie and rejects malformed responses", async () => {
    const expiresAt = Date.now() + 60_000;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        playbackSessionId: "pbs_bbbbbbbbbbbbbbbbbbbbbbbb",
        manifestUrl: "/broadcast/play/res_bbbbbbbbbbbbbbbb/index.m3u8",
        expiresAt,
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const service = new BroadcastPlaybackGatewayService();
    await service.open("res_bbbbbbbbbbbbbbbb", "signed-playback-grant", new AbortController().signal);
    await service.close();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/broadcast/playback-sessions/pbs_bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(service.session()).toBeNull();
    fetchMock.mockRestore();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ manifestUrl: "https://evil.test/x" }), { status: 201 }));
    await expect(new BroadcastPlaybackGatewayService().open(
      "res_bbbbbbbbbbbbbbbb", "signed-playback-grant", new AbortController().signal,
    )).rejects.toThrow("invalid_broadcast_playback_gateway_response");
    vi.restoreAllMocks();
  });

  it("renews the same opaque cookie session with a fresh header-only grant", async () => {
    const initialExpiry = Date.now() + 30_000;
    const renewedExpiry = Date.now() + 60_000;
    const body = (expiresAt: number) => JSON.stringify({
      playbackSessionId: "pbs_cccccccccccccccccccccccc",
      manifestUrl: "/broadcast/play/res_cccccccccccccccc/index.m3u8",
      expiresAt,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(body(initialExpiry), { status: 201 }))
      .mockResolvedValueOnce(new Response(body(renewedExpiry), { status: 200 }));
    const service = new BroadcastPlaybackGatewayService();
    await service.open("res_cccccccccccccccc", "initial-playback-grant", new AbortController().signal);
    const renewed = await service.renew(
      "res_cccccccccccccccc", "renewed-playback-grant", new AbortController().signal,
    );
    expect(renewed.expiresAt).toBe(renewedExpiry);
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/broadcast/playback-sessions/pbs_cccccccccccccccccccccccc",
      expect.objectContaining({
        method: "PUT",
        headers: { authorization: "Bearer renewed-playback-grant", "content-type": "application/json" },
        body: JSON.stringify({ resourceRef: "res_cccccccccccccccc" }),
      }),
    ]);
    expect(JSON.stringify(service.session())).not.toContain("playback-grant");
    fetchMock.mockRestore();
  });
});
