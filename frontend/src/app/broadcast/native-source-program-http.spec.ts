import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { BroadcastControlPlaneService } from "./broadcast-control-plane.service";
const contract = new Ajv2020().compile(JSON.parse(readFileSync("contracts/native-packager/source-program-start.v1.schema.json", "utf8")));
const packagerId = "pkr_aaaaaaaaaaaaaaaa";
const program = { tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 1, programEpoch: 1 };
function response() {
  return { program: { ...program, programRevision: 3, programEpoch: 1 }, ownerSubjectRef: "sub_aaaaaaaaaaaaaaaa",
    assignment: { assignmentId: "asn_aaaaaaaaaaaaaaaa", packagerId, roomId: program.roomId, programId: program.programId,
      inputMode: "trusted-sframe-v1", programEpoch: 1, fencingRevision: 4, profileId: "h264-aac-720p-v1", renditionIds: ["low"], state: "preparing",
      reasonCode: "AWAITING_AGENT", createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 30000 } };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 201, headers: { "content-type": "application/json" } });
const service = () => new BroadcastControlPlaneService({ authorizationHeader: () => ({ Authorization: "Bearer synthetic" }) } as never,
  { fingerprint: () => "a".repeat(43) } as never);
afterEach(() => vi.restoreAllMocks());

it.each([undefined, { codec: "aac" as const, sampleRate: 48000 as const, channels: 1 as const, targetBitsPerSecond: 48000 }])(
  "sends a closed v3 video choice with explicit nullable audio", async audioOutput => {
    const validate = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync("contracts/native-packager/source-program-start.v3.schema.json", "utf8")));
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(response()));
    await service().prepareNativeSourceStart(program, packagerId, 2, false, "user-action", new AbortController().signal,
      audioOutput, { profile: "screen-v1" });
    const body = JSON.parse(String(fetch.mock.calls[0][1]!.body));
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    expect(body.videoOutput).toEqual({ profile: "screen-v1" }); expect(body.audioOutput).toEqual(audioOutput ?? null);
  });

it("rejects malformed video before identity or network access", async () => {
  const fingerprint = vi.fn(() => "a".repeat(43)), authorizationHeader = vi.fn(() => ({}));
  const control = new BroadcastControlPlaneService({ authorizationHeader } as never, { fingerprint } as never);
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const video of [null, {}, { profile: "screen-v2" }, { profile: "screen-v1", fps: 60 }]) {
    await expect(control.prepareNativeSourceStart(program, packagerId, 1, false, "user-action", new AbortController().signal,
      undefined, video as never)).rejects.toThrow();
  }
  expect(fingerprint).not.toHaveBeenCalled(); expect(authorizationHeader).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

const handoffSnapshot = { controlVersion: 1 as const, programId: program.programId, programRevision: 4, programEpoch: 1,
  state: "live", handoffPending: false, writer: { packagerId: "pkr_bbbbbbbbbbbbbbbb", fencingRevision: 3 } };
const sourceHandoff = (control: BroadcastControlPlaneService, snapshot = handoffSnapshot, signal = new AbortController().signal) =>
  control.prepareNativeSourceHandoff(program, snapshot, packagerId, 2, false, "user-action", signal);

it("accepts a source handoff only at the next epoch with a newer fence and consumes its assignment", async () => {
  const value = response(); value.program.programRevision = 6; value.program.programEpoch = value.assignment.programEpoch = 2;
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(value)), control = service();
  const result = await sourceHandoff(control);
  expect(result.assignment).toMatchObject({ programEpoch: 2, fencingRevision: 4, packagerId });
  expect(() => control.takePreparedNative(result.program)).toThrow("assignment_required");
  expect(fetch.mock.calls[0][0]).toBe(`/api/broadcasts/${program.programId}/native-handoffs`);
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ requestVersion: 1, trigger: "user-action",
    deviceFingerprint: "a".repeat(43), packagerId, requestedRenditions: 2, allowHardwareAcceleration: false,
    expectedProgramRevision: 4, expectedProgramEpoch: 1, expectedFencingRevision: 3 });
});
for (const change of ["same-epoch", "skipped-epoch", "stale-revision", "stale-fence", "wrong-mode", "wrong-owner", "wrong-room", "oversize"])
  it(`denies ${change} source handoff replies`, async () => {
    const value = response(); value.program.programRevision = 6; value.program.programEpoch = value.assignment.programEpoch = 2;
    if (change === "same-epoch") value.program.programEpoch = value.assignment.programEpoch = 1;
    if (change === "skipped-epoch") value.program.programEpoch = value.assignment.programEpoch = 3;
    if (change === "stale-revision") value.program.programRevision = 4;
    if (change === "stale-fence") value.assignment.fencingRevision = 3;
    if (change === "wrong-mode") Reflect.deleteProperty(value.assignment, "inputMode");
    if (change === "wrong-owner") value.program.tenantId = "tn_bbbbbbbbbbbbbbbb";
    if (change === "wrong-room") value.program.roomId = "room-other";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(change === "oversize" ? { ...value, padding: "x".repeat(16384) } : value));
    const control = service(); await expect(sourceHandoff(control)).rejects.toThrow();
    expect(() => control.takePreparedNative(value.program)).toThrow("assignment_required");
  });

it("denies stale CAS, implicit action and cancellation before dispatch", async () => {
  const fetch = vi.spyOn(globalThis, "fetch"), control = service();
  await expect(sourceHandoff(control, { ...handoffSnapshot, programRevision: 0 })).rejects.toThrow();
  await expect(control.prepareNativeSourceHandoff(program, handoffSnapshot, packagerId, 2, false, "remote", new AbortController().signal)).rejects.toThrow();
  const abort = new AbortController(), pending = sourceHandoff(control, handoffSnapshot, abort.signal);
  abort.abort(); await expect(pending).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
});

it("emits the additive v2 output request, without changing the assignment response or legacy schema", async () => {
  const validate = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync("contracts/native-packager/source-program-start.v2.schema.json", "utf8")));
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(response()));
  const audioOutput = { codec: "aac" as const, sampleRate: 48000 as const, channels: 1 as const, targetBitsPerSecond: 48000 };
  const result = await service().prepareNativeSourceStart(program, packagerId, 2, false, "user-action", new AbortController().signal, audioOutput);
  const body = JSON.parse(String(fetch.mock.calls[0][1]!.body));
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(contract(body)).toBe(false); expect(body.audioOutput).toEqual(audioOutput); expect(body.requestVersion).toBe(2);
  expect(result.assignment.packagerId).toBe(packagerId);
});

it("rejects invalid output and cancellation during module loading before identity or network access", async () => {
  const fingerprint = vi.fn(() => "a".repeat(43)), authorizationHeader = vi.fn(() => ({}));
  const control = new BroadcastControlPlaneService({ authorizationHeader } as never, { fingerprint } as never);
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const output of [null, {}, { codec: "aac", sampleRate: 48000, channels: 1, targetBitsPerSecond: 320000 }]) {
    await expect(control.prepareNativeSourceStart(program, packagerId, 1, false, "user-action", new AbortController().signal, output as never)).rejects.toThrow();
  }
  const abort = new AbortController();
  const pending = control.prepareNativeSourceStart(program, packagerId, 1, false, "user-action", abort.signal);
  abort.abort(); await expect(pending).rejects.toThrow();
  expect(fingerprint).not.toHaveBeenCalled(); expect(authorizationHeader).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it("sends precisely the source-start schema without legacy sources, and consumes the assignment without a media adapter", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(response())), control = service();
  const started = await control.prepareNativeSourceStart(program, packagerId, 1, false, "user-action", new AbortController().signal);
  expect(fetch).toHaveBeenCalledWith(`/api/broadcasts/${program.programId}/native-source-programs`, expect.objectContaining({
    method: "POST", credentials: "same-origin", redirect: "error", signal: expect.any(AbortSignal) }));
  const body = JSON.parse(String(fetch.mock.calls[0][1]!.body));
  expect(contract(body), JSON.stringify(contract.errors)).toBe(true);
  expect(body).toEqual({ requestVersion: 1, trigger: "user-action", inputMode: "trusted-sframe-v1", packagerId,
    deviceFingerprint: "a".repeat(43), requestedRenditions: 1, allowHardwareAcceleration: false });
  expect(started.assignment).toMatchObject({ packagerId, programEpoch: 1, fencingRevision: 4 });
  expect(() => control.takePreparedNative(started.program)).toThrow("assignment_required");
});

it("rejects aborted or implicit starts before making any request", async () => {
  const fetch = vi.spyOn(globalThis, "fetch"), control = service();
  await expect(control.prepareNativeSourceStart(program, packagerId, 1, false, "remote", new AbortController().signal)).rejects.toThrow();
  await expect(control.prepareNativeSourceStart(program, packagerId, 1, false, "user-action", AbortSignal.abort())).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("does not accept a v4 input mode on the legacy start or handoff route", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const value = response(); value.program.programEpoch = value.assignment.programEpoch = 2;
    return json(value);
  });
  const control = service(), signal = new AbortController().signal;
  await expect(control.prepareNativeStart(program, ["src_aaaaaaaaaaaaaaaa"], packagerId, 1, signal))
    .rejects.toMatchObject({ code: "invalid_native_packager_assignment_response" });
  await expect(control.prepareNativeHandoff(program, { controlVersion: 1, programId: program.programId,
    programRevision: 1, programEpoch: 1, state: "live", handoffPending: false,
    writer: { packagerId: "pkr_bbbbbbbbbbbbbbbb", fencingRevision: 3 } }, packagerId, 1, signal))
    .rejects.toMatchObject({ code: "invalid_native_packager_assignment_response" });
  expect(() => control.takePreparedNative(response().program)).toThrow("assignment_required");
});

for (const kind of ["oversize", "content-type", "invalid-json", "extra", "tenant", "room", "epoch", "legacy-epoch", "packager", "fence", "missing-mode", "unknown-mode"]) {
  it(`fails closed for ${kind} responses without retaining an assignment`, async () => {
    const value = response();
    if (kind === "extra") Object.assign(value.assignment, { sourceIds: [] });
    if (kind === "missing-mode") Reflect.deleteProperty(value.assignment, "inputMode");
    if (kind === "unknown-mode") value.assignment.inputMode = "legacy";
    if (kind === "tenant") value.program.tenantId = "tn_bbbbbbbbbbbbbbbb";
    if (kind === "room") value.program.roomId = "room-other";
    if (kind === "epoch") value.program.programEpoch = 3;
    if (kind === "legacy-epoch") value.program.programEpoch = value.assignment.programEpoch = 2;
    if (kind === "packager") value.assignment.packagerId = "pkr_bbbbbbbbbbbbbbbb";
    if (kind === "fence") value.assignment.fencingRevision = 0;
    let reply = json(value);
    if (kind === "oversize") reply = json({ ...value, padding: "x".repeat(16384) });
    if (kind === "content-type") reply = new Response(JSON.stringify(value), { status: 201 });
    if (kind === "invalid-json") reply = new Response("{", { headers: { "content-type": "application/json" } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply); const control = service();
    await expect(control.prepareNativeSourceStart(program, packagerId, 1, false, "user-action", new AbortController().signal))
      .rejects.toMatchObject({ code: "invalid_native_packager_assignment_response" });
    expect(() => control.takePreparedNative(value.program)).toThrow("assignment_required");
  });
}

it("waits for a lost-response assignment to actually stop, without touching unrelated programs", async () => {
  const row = { programId: program.programId, state: "draining" };
  const fetch = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(json({ packagers: [], assignments: [row, { programId: "prg_bbbbbbbbbbbbbbbb", state: "running" }] }))
    .mockResolvedValueOnce(json({ packagers: [], assignments: [{ ...row, state: "stopped" }, { programId: "prg_bbbbbbbbbbbbbbbb", state: "running" }] }));
  await service().confirmNativeProgramStopped(program.programId, new AbortController().signal);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [url, init] of fetch.mock.calls) { expect(url).toBe("/api/native-packagers"); expect(init?.method).toBeUndefined(); }
});

it("fails closed when lost-response cleanup cannot obtain a valid inventory", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ packagers: [], assignments: [{ programId: program.programId, state: "unknown" }] }));
  await expect(service().confirmNativeProgramStopped(program.programId, new AbortController().signal))
    .rejects.toMatchObject({ code: "invalid_native_packager_assignment_confirmation" });
});
