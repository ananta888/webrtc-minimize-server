import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

import { BroadcastControlPlaneService } from "./broadcast-control-plane.service";
import { parseNativeHandoffControl } from "./native-packager-handoff-control";

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
const handoffContract = new Ajv2020().compile(JSON.parse(readFileSync("contracts/native-packager/handoff.v1.schema.json", "utf8")));

describe("BroadcastControlPlaneService", () => {
  for (const version of [1, 2]) it(`queries scene v2 but preserves negotiated v${version} on explicit apply`, async () => {
    const scope = { sceneControlVersion: version, programId: program.programId, programRevision: 1, programEpoch: 1,
      packagerId: "pkr_aaaaaaaaaaaaaaaa", assignmentId: "asn_aaaaaaaaaaaaaaaa", fencingRevision: 1 };
    const selection = { expectedSceneRevision: 1, layout: "grid" as const, sourceLeaseIds: [], activeSourceLeaseId: "",
      ...(version === 2 ? { sourceFits: [] } : {}) };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ ...scope, outcome: "observed", observedAt: Date.now(),
      sceneRevision: 1, layout: "grid", sourceLeaseIds: [], activeSourceLeaseId: "", availableSources: [],
      ...(version === 2 ? { sourceFits: [] } : {}) })).mockResolvedValueOnce(json({ ...scope, outcome: "applied", appliedAt: Date.now(), sceneRevision: 2 }));
    const service = new BroadcastControlPlaneService({ authorizationHeader: () => ({ Authorization: "Bearer oidc" }) } as never,
      { fingerprint: () => "f".repeat(43) } as never);
    try {
      await expect(service.nativeSourceScene(program, null, new AbortController().signal)).resolves.toMatchObject({ outcome: "observed", sceneControlVersion: version });
      await expect(service.nativeSourceScene(program, selection, new AbortController().signal)).resolves.toMatchObject({ outcome: "applied", sceneControlVersion: version });
      const bodies = fetchMock.mock.calls.map(([, options]) => JSON.parse(String(options?.body)));
      expect(bodies[0]).toMatchObject({ requestVersion: 2, action: "query" });
      expect(bodies[1]).toMatchObject({ requestVersion: version, action: "apply", trigger: "user-action", ...selection });
      for (const [, options] of fetchMock.mock.calls) expect(options).toMatchObject({ cache: "no-store", redirect: "error", credentials: "same-origin" });
    } finally { fetchMock.mockRestore(); }
  });

  it("does not send a scene operation cancelled while its deferred parser is loading", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const service = new BroadcastControlPlaneService({ authorizationHeader: () => ({}) } as never,
      { fingerprint: () => "f".repeat(43) } as never), abort = new AbortController();
    try {
      const pending = service.nativeSourceScene(program, null, abort.signal); abort.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });

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

  it("waits for the native agent stop acknowledgement before allowing reuse", async () => {
    const assignment = {
      assignmentId: "asn_0123456789abcdef", packagerId: "pkr_0123456789abcdef",
      programId: program.programId, programEpoch: 2, fencingRevision: 3, expiresAt: Date.now() + 30_000,
    };
    const draining = { ...assignment, roomId: program.roomId, profileId: "h264-aac-720p-v1",
      renditionIds: ["low"], state: "draining", reasonCode: "OWNER_STOP",
      createdAt: Date.now(), updatedAt: Date.now() };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ assignment: draining }, 200))
      .mockResolvedValueOnce(json({ packagers: [], assignments: [draining] }, 200))
      .mockResolvedValueOnce(json({ packagers: [], assignments: [{ ...draining, state: "stopped" }] }, 200));
    const service = new BroadcastControlPlaneService(
      { authorizationHeader: () => ({ Authorization: "Bearer oidc" }) } as never,
      {} as never,
    );
    await service.stopNativeAssignment(assignment, new AbortController().signal);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/native-packagers/" + assignment.packagerId + "/assignments/" + assignment.assignmentId,
      "/api/native-packagers",
      "/api/native-packagers",
    ]);
  });

  const snapshot = { controlVersion: 1, programId: program.programId, programRevision: 8, programEpoch: 2,
    state: "live", handoffPending: false, writer: { packagerId: "pkr_aaaaaaaaaaaaaaaa", fencingRevision: 3 } };
  function nativeResponse() {
    return { program: { ...program, programRevision: 10, programEpoch: 3 }, ownerSubjectRef: "sub_cccccccccccccccc",
      assignment: { assignmentId: "asn_0123456789abcdef", packagerId: "pkr_bbbbbbbbbbbbbbbb",
        roomId: program.roomId, programId: program.programId, programEpoch: 3, fencingRevision: 5,
        profileId: "h264-aac-720p-v1", renditionIds: ["low"], state: "preparing", reasonCode: "AWAITING_AGENT",
        createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 30_000 } };
  }
  function nativeService() {
    return new BroadcastControlPlaneService({ authorizationHeader: () => ({ Authorization: "Bearer oidc" }) } as never,
      { fingerprint: () => "f".repeat(43) } as never);
  }

  it("does not read identity or send a handoff query when cancelled during adapter loading", async () => {
    const fingerprint = vi.fn(() => "f".repeat(43)), authorizationHeader = vi.fn(() => ({ Authorization: "Bearer oidc" }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReset();
    const service = new BroadcastControlPlaneService({ authorizationHeader } as never, { fingerprint } as never);
    const controller = new AbortController();
    const pending = service.nativeHandoffControl(program.programId, controller.signal);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fingerprint).not.toHaveBeenCalled(); expect(authorizationHeader).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains the 4096-byte handoff response limit after adapter extraction", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReset();
    const body = JSON.stringify(snapshot);
    fetchMock.mockResolvedValueOnce(new Response(body.padEnd(4096, " "), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(body.padEnd(4097, " "), { headers: { "content-type": "application/json" } }));
    const service = nativeService();
    expect(await service.nativeHandoffControl(program.programId, new AbortController().signal)).toEqual(snapshot);
    await expect(service.nativeHandoffControl(program.programId, new AbortController().signal)).rejects.toMatchObject({ code: "invalid_native_handoff_control" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetches a closed device-bound snapshot and sends precisely its revisions, not stale local revisions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(snapshot, 200)).mockResolvedValueOnce(json(nativeResponse()));
    const service = nativeService(), signal = new AbortController().signal;
    const control = await service.nativeHandoffControl(program.programId, signal);
    const prepared = await service.prepareNativeHandoff({ ...program, programEpoch: 2 }, control,
      "pkr_bbbbbbbbbbbbbbbb", 1, signal);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/broadcasts/${program.programId}/native-handoff-control`, `/api/broadcasts/${program.programId}/native-handoffs`,
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      requestVersion: 1, trigger: "user-action", deviceFingerprint: "f".repeat(43), packagerId: "pkr_bbbbbbbbbbbbbbbb",
      expectedProgramRevision: 8, expectedProgramEpoch: 2, expectedFencingRevision: 3, requestedRenditions: 1,
      allowHardwareAcceleration: true,
    });
    for (const [, request] of fetchMock.mock.calls) expect(handoffContract(JSON.parse(String(request?.body)))).toBe(true);
    expect(handoffContract(control)).toBe(true);
    expect(service.takePreparedNative(prepared.program)).toMatchObject({ programEpoch: 3, fencingRevision: 5 });
    expect(() => service.takePreparedNative(prepared.program)).toThrow();
  });

  it("rejects unknown, loose or cross-program control snapshots", () => {
    for (const bad of [null, [], { ...snapshot, extra: true }, { ...snapshot, programRevision: "8" },
      { ...snapshot, programEpoch: 0 }, { ...snapshot, state: "running" }, { ...snapshot, handoffPending: 0 },
      { ...snapshot, programId: "prg_dddddddddddddddd" }, { ...snapshot, writer: {} },
      { ...snapshot, writer: { ...snapshot.writer, fencingRevision: "3" } },
      { ...snapshot, writer: { ...snapshot.writer, secret: "not-allowed" } }]) {
      expect(() => parseNativeHandoffControl(bad, program.programId)).toThrow("invalid_native_handoff_control");
    }
    expect(parseNativeHandoffControl({ ...snapshot, writer: null }, program.programId).writer).toBeNull();
  });

  it("gives independent bounded lifetimes to assignment and program cleanup", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort(new DOMException("timeout", "TimeoutError")));
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockClear();
    const service = nativeService(), response = nativeResponse();
    try {
      await expect(service.stopNativeAssignment(response.assignment, new AbortController().signal)).rejects.toThrow("timeout");
      await expect(service.stopProgram(program.programId, new AbortController().signal)).rejects.toThrow("timeout");
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([15_000, 12_000]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { timeout.mockRestore(); }
  });

  for (const scenario of ["tenant", "room", "program", "epoch", "revision", "fence", "target", "extra", "abort", "owner-type", "id-type", "profile", "rendition", "state", "time"]) {
    it(`never caches a ${scenario} mismatched or late successor`, async () => {
      const response = nativeResponse(), controller = new AbortController();
      if (scenario === "tenant") response.program.tenantId = "tn_dddddddddddddddd";
      if (scenario === "room") response.program.roomId = "room-other";
      if (scenario === "program") {
        response.program.programId = "prg_dddddddddddddddd";
        response.assignment.programId = response.program.programId;
      }
      if (scenario === "epoch") { response.program.programEpoch = 2; response.assignment.programEpoch = 2; }
      if (scenario === "revision") response.program.programRevision = 8;
      if (scenario === "fence") response.assignment.fencingRevision = 3;
      if (scenario === "target") response.assignment.packagerId = snapshot.writer.packagerId;
      if (scenario === "extra") Object.assign(response.assignment, { extra: true });
      if (scenario === "owner-type") Object.assign(response, { ownerSubjectRef: [response.ownerSubjectRef] });
      if (scenario === "id-type") Object.assign(response.assignment, { assignmentId: [response.assignment.assignmentId] });
      if (scenario === "profile") response.assignment.profileId = "unknown";
      if (scenario === "rendition") response.assignment.renditionIds = ["low", "low"];
      if (scenario === "state") response.assignment.state = "stopped";
      if (scenario === "time") response.assignment.updatedAt = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (scenario === "abort") controller.abort();
        return json(response);
      });
      const service = nativeService();
      await expect(service.prepareNativeHandoff({ ...program, programEpoch: 2 }, snapshot as never,
        "pkr_bbbbbbbbbbbbbbbb", 1, controller.signal)).rejects.toThrow();
      expect(() => service.takePreparedNative(response.program)).toThrow("native_packager_assignment_required");
    });
  }
});
