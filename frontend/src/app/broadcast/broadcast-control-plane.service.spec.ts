import { describe, expect, it, vi } from "vitest";

import { BroadcastControlPlaneService } from "./broadcast-control-plane.service";

const program = {
  tenantId: "tn_aaaaaaaaaaaaaaaa",
  roomId: "room-alpha",
  programId: "prg_bbbbbbbbbbbbbbbb",
  programRevision: 1,
  programEpoch: 1,
};
const proofContext = {
  tenantId: program.tenantId,
  subjectRef: "sub_cccccccccccccccc",
  roomId: program.roomId,
  programId: program.programId,
  programRevision: 3,
  programEpoch: 2,
  grantKind: "publisher",
  tokenAudience: "broadcast-publisher",
  audienceRef: "sub_cccccccccccccccc",
  resourceRef: "res_dddddddddddddddd",
  pathHash: "e".repeat(64),
  actions: ["whip:create"],
};
const json = (value: unknown, status = 201) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

describe("BroadcastControlPlaneService", () => {
  it("creates a program and returns only its bounded control reference", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      program: { directoryVersion: 1 },
      control: program,
    }));
    const service = new BroadcastControlPlaneService(
      { authorizationHeader: () => ({ Authorization: "Bearer oidc" }) } as never,
      {} as never,
    );
    await expect(service.createProgram(
      "room-alpha", "Pilot", "private", new AbortController().signal,
    )).resolves.toEqual(program);
    expect(fetchMock).toHaveBeenCalledWith("/api/broadcasts", expect.objectContaining({ method: "POST" }));
  });

  it("pre-authorizes a device-bound start and lets WHIP consume it exactly once", async () => {
    const device = {
      fingerprint: () => "f".repeat(43),
      createBroadcastGrantProof: vi.fn(async () => ({
        publicKey: { kty: "EC" }, timestamp: Date.now(), nonce: "n".repeat(24), signature: "s".repeat(86),
      })),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({
        challengeVersion: 1,
        challengeId: `bpc_${"a".repeat(24)}`,
        proofContext,
        expiresAt: Date.now() + 30_000,
      }))
      .mockResolvedValueOnce(json({
        authorizationVersion: 1,
        accessToken: "temporary-publisher-grant",
        expiresAt: Date.now() + 30_000,
        program: { ...program, programRevision: 3, programEpoch: 2 },
        resourceRef: proofContext.resourceRef,
        resourceUrl: `https://media.example/broadcast/ingest/${proofContext.resourceRef}/whip`,
      }));
    const service = new BroadcastControlPlaneService(
      { authorizationHeader: () => ({ Authorization: "Bearer oidc" }) } as never,
      device as never,
    );
    const prepared = await service.prepareStart(
      program,
      ["src_aaaaaaaaaaaaaaaa"],
      new AbortController().signal,
    );
    expect(prepared.program).toEqual({ ...program, programRevision: 3, programEpoch: 2 });
    expect(prepared.ownerSubjectRef).toBe(proofContext.subjectRef);
    const authorization = await service.authorize({
      requestVersion: 1,
      program: prepared.program,
      action: "whip:create",
      resourceUrl: "https://media.example/broadcast/ingest",
    }, new AbortController().signal);
    expect(authorization.resourceUrl).toContain(proofContext.resourceRef);
    expect(device.createBroadcastGrantProof).toHaveBeenCalledWith(proofContext);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/broadcasts/${program.programId}/publisher-challenges`,
      `/api/broadcasts/${program.programId}/publisher-authorizations`,
    ]);
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(firstBody.deviceFingerprint).toBe("f".repeat(43));
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("temporary-publisher-grant");
    await expect(service.authorize({
      requestVersion: 1,
      program: prepared.program,
      action: "whip:create",
      resourceUrl: "https://media.example/broadcast/ingest",
    }, new AbortController().signal)).rejects.toMatchObject({
      code: "broadcast_start_authorization_required",
    });
  });

  it("prepares and consumes one device- and fence-bound native assignment", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      assignment: {
        assignmentId: "asn_0123456789abcdef", packagerId: "pkr_0123456789abcdef",
        roomId: program.roomId, programId: program.programId, programEpoch: 2, fencingRevision: 3,
        profileId: "h264-aac-720p-v1", renditionIds: ["low"], state: "preparing",
        reasonCode: "AWAITING_AGENT", createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 30_000,
      },
      program: { ...program, programRevision: 3, programEpoch: 2 },
      ownerSubjectRef: "sub_cccccccccccccccc",
    }));
    const service = new BroadcastControlPlaneService(
      { authorizationHeader: () => ({ Authorization: "Bearer oidc" }) } as never,
      { fingerprint: () => "f".repeat(43) } as never,
    );
    const prepared = await service.prepareNativeStart(program, ["src_aaaaaaaaaaaaaaaa"],
      "pkr_0123456789abcdef", 1, new AbortController().signal);
    expect(prepared.program.programEpoch).toBe(2);
    expect(service.takePreparedNative(prepared.program)).toMatchObject({
      assignmentId: "asn_0123456789abcdef", fencingRevision: 3,
    });
    expect(() => service.takePreparedNative(prepared.program)).toThrow("native_packager_assignment_required");
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body).toMatchObject({ trigger: "user-action", deviceFingerprint: "f".repeat(43) });
  });
});
