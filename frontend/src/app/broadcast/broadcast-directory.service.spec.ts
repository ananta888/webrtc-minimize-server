import { describe, expect, it, vi } from "vitest";

import { BroadcastDirectoryService } from "./broadcast-directory.service";

const entry = (programId: string, overrides = {}) => ({
  directoryVersion: 1,
  programId,
  title: "Live aus dem Raum",
  ownerLabel: "Alice",
  ownerVisibility: "shown",
  visibility: "public",
  availability: "live",
  viewerCount: 12,
  latencyMode: "ll-hls",
  captions: true,
  programEpoch: 3,
  policyRevision: 4,
  playback: "public",
  ...overrides,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const auth = { authorizationHeader: () => ({ authorization: "Bearer test-only" }) };

describe("BroadcastDirectoryService", () => {
  it("keeps public, entitled private, owned and ended sections separate", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ programs: [entry("prg_aaaaaaaaaaaaaaaa")] }))
      .mockResolvedValueOnce(response({
        authorized: [entry("prg_bbbbbbbbbbbbbbbb", { visibility: "private", playback: "grant-required" })],
        owned: [entry("prg_cccccccccccccccc", { visibility: "private", availability: "ended", playback: "grant-required" })],
      }));
    const service = new BroadcastDirectoryService(auth as never);
    await service.load(true);
    expect(service.publicPrograms()).toHaveLength(1);
    expect(service.privatePrograms()).toHaveLength(1);
    expect(service.ownPrograms()).toHaveLength(0);
    expect(service.endedPrograms().map(({ programId }) => programId)).toEqual(["prg_cccccccccccccccc"]);
  });

  it("never asks for or accepts private entries from the anonymous public endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      programs: [entry("prg_aaaaaaaaaaaaaaaa", { visibility: "private" })],
    }));
    const service = new BroadcastDirectoryService(auth as never);
    await expect(service.load(false)).rejects.toThrow("invalid_broadcast_directory_response");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/broadcasts/public");
  });

  it("maps 403 and 404 to the same non-enumerating playback state", async () => {
    const service = new BroadcastDirectoryService(auth as never);
    for (const status of [403, 404]) {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response({}, status));
      await expect(service.authorize("prg_aaaaaaaaaaaaaaaa", new AbortController().signal))
        .rejects.toThrow("broadcast_not_available");
    }
  });

  it("authorizes playback in a POST body and keeps its grant out of the deep link", async () => {
    const program = entry("prg_aaaaaaaaaaaaaaaa", { visibility: "private", playback: "grant-required" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      bootstrapVersion: 1,
      program,
      resourceRef: "res_aaaaaaaaaaaaaaaa",
      playbackGrant: "temporary-playback-grant",
      expiresAt: Date.now() + 30_000,
    }));
    const service = new BroadcastDirectoryService(auth as never);
    expect((await service.authorize(program.programId, new AbortController().signal)).resourceRef)
      .toBe("res_aaaaaaaaaaaaaaaa");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/broadcasts/prg_aaaaaaaaaaaaaaaa/playback");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("temporary-playback-grant");
    expect(service.deepLink(program.programId)).toBe("/?section=broadcast&program=prg_aaaaaaaaaaaaaaaa");
    expect(service.programFromUrl(`${location.origin}/?section=broadcast&program=prg_aaaaaaaaaaaaaaaa`))
      .toBe("prg_aaaaaaaaaaaaaaaa");
  });

  it("rejects unknown response fields, owner leaks and token-like deep links", async () => {
    const service = new BroadcastDirectoryService(auth as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response({ programs: [
      entry("prg_aaaaaaaaaaaaaaaa", { ownerVisibility: "hidden", ownerLabel: "must-not-leak" }),
    ] }));
    await expect(service.load(false)).rejects.toThrow("invalid_broadcast_directory_response");
    expect(service.programFromUrl("/?section=broadcast&program=prg_aaaaaaaaaaaaaaaa&token=secret")).toBeNull();
  });
});
