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
const proofContext = {
  tenantId: "tn_aaaaaaaaaaaaaaaa",
  subjectRef: "sub_bbbbbbbbbbbbbbbb",
  roomId: "room-alpha",
  programId: "prg_aaaaaaaaaaaaaaaa",
  programRevision: 2,
  programEpoch: 3,
  grantKind: "playback",
  tokenAudience: "broadcast-playback",
  audienceRef: "sub_bbbbbbbbbbbbbbbb",
  resourceRef: "res_aaaaaaaaaaaaaaaa",
  pathHash: "a".repeat(64),
  actions: ["playback:manifest", "playback:segment"],
} as const;
const device = { createBroadcastGrantProof: vi.fn(async () => ({
  publicKey: { kty: "EC", crv: "P-256", x: "a".repeat(43), y: "b".repeat(43) },
  timestamp: Date.now(), nonce: "n".repeat(24), signature: "s".repeat(86),
})) };
const service = () => new BroadcastDirectoryService(auth as never, device as never);

describe("BroadcastDirectoryService", () => {
  it("keeps public, entitled private, owned and ended sections separate", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ programs: [entry("prg_aaaaaaaaaaaaaaaa")] }))
      .mockResolvedValueOnce(response({
        authorized: [entry("prg_bbbbbbbbbbbbbbbb", { visibility: "private", playback: "grant-required" })],
        owned: [entry("prg_cccccccccccccccc", { visibility: "private", availability: "ended", playback: "grant-required" })],
      }));
    const directory = service();
    await directory.load(true);
    expect(directory.publicPrograms()).toHaveLength(1);
    expect(directory.privatePrograms()).toHaveLength(1);
    expect(directory.ownPrograms()).toHaveLength(0);
    expect(directory.endedPrograms().map(({ programId }) => programId)).toEqual(["prg_cccccccccccccccc"]);
  });

  it("never asks for or accepts private entries from the anonymous public endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      programs: [entry("prg_aaaaaaaaaaaaaaaa", { visibility: "private" })],
    }));
    const directory = service();
    await expect(directory.load(false)).rejects.toThrow("invalid_broadcast_directory_response");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/broadcasts/public");
  });

  it("maps 403 and 404 to the same non-enumerating playback state", async () => {
    const directory = service();
    for (const status of [403, 404]) {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response({}, status));
      await expect(directory.authorize("prg_aaaaaaaaaaaaaaaa", new AbortController().signal))
        .rejects.toThrow("broadcast_not_available");
    }
  });

  it("authorizes playback in a POST body and keeps its grant out of the deep link", async () => {
    const program = entry("prg_aaaaaaaaaaaaaaaa", { visibility: "private", playback: "grant-required" });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({
        challengeVersion: 1,
        challengeId: `bpc_${"a".repeat(24)}`,
        proofContext,
        expiresAt: Date.now() + 30_000,
      }, 201))
      .mockResolvedValueOnce(response({
        bootstrapVersion: 1,
        program,
        resourceRef: "res_aaaaaaaaaaaaaaaa",
        playbackGrant: "temporary-playback-grant",
        expiresAt: Date.now() + 30_000,
      }, 201));
    const directory = service();
    expect((await directory.authorize(program.programId, new AbortController().signal)).resourceRef)
      .toBe("res_aaaaaaaaaaaaaaaa");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/broadcasts/prg_aaaaaaaaaaaaaaaa/playback-challenges");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/broadcasts/prg_aaaaaaaaaaaaaaaa/playback");
    expect(String(fetchMock.mock.calls[1][0])).not.toContain("temporary-playback-grant");
    expect(device.createBroadcastGrantProof).toHaveBeenCalledWith(proofContext);
    expect(directory.deepLink(program.programId)).toBe("/?section=broadcast&program=prg_aaaaaaaaaaaaaaaa");
    expect(directory.programFromUrl(`${location.origin}/?section=broadcast&program=prg_aaaaaaaaaaaaaaaa`))
      .toBe("prg_aaaaaaaaaaaaaaaa");
  });

  it("rejects unknown response fields, owner leaks and token-like deep links", async () => {
    const directory = service();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response({ programs: [
      entry("prg_aaaaaaaaaaaaaaaa", { ownerVisibility: "hidden", ownerLabel: "must-not-leak" }),
    ] }));
    await expect(directory.load(false)).rejects.toThrow("invalid_broadcast_directory_response");
    expect(directory.programFromUrl("/?section=broadcast&program=prg_aaaaaaaaaaaaaaaa&token=secret")).toBeNull();
  });
});
