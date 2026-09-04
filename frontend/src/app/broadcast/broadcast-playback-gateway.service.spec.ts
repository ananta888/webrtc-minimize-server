import { describe, expect, it, vi } from "vitest";

import { BroadcastPlaybackGatewayService } from "./broadcast-playback-gateway.service";

describe("BroadcastPlaybackGatewayService", () => {
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
});
