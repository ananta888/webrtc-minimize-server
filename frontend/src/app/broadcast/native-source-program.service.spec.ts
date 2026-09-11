import { signal } from "@angular/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeSourceProgramService } from "./native-source-program.service";

const NOW = 1800000000000, packagerId = "pkr_aaaaaaaaaaaaaaaa";
const program = { tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 1, programEpoch: 1 };
const prepared = { ...program, programRevision: 3, programEpoch: 2 };
const assignment = { assignmentId: "asn_aaaaaaaaaaaaaaaa", packagerId, programId: program.programId, programEpoch: 2,
  fencingRevision: 4, expiresAt: NOW + 5000 };
const request = { roomId: "room-alpha", title: "Studio", visibility: "private" as const, packagerId,
  requestedRenditions: 1, allowHardwareAcceleration: false };
function fixture() {
  const claims = signal({ iss: "https://identity.example", sub: "human", exp: NOW / 1000 + 300 });
  const room = { roomId: signal("room-alpha"), peerId: signal("0123456789abcdef"), joined: signal(true),
    roomCreator: signal(true), machineExpiresAt: signal(0) };
  const mesh = { ownPeerId: signal(room.peerId()), membershipEpoch: signal(2) }, signaling = { status: signal("connected") };
  const config = signal({ nativePackagers: { publicationEnabled: true } });
  const candidates = signal([{ id: packagerId, capability: { capabilityVersion: 2, sourcePrograms: true, maximumRenditions: 3 } }]);
  const control = { createProgram: vi.fn(async () => program), prepareNativeSourceStart: vi.fn(async () => ({ program: prepared, assignment })),
    nativeHandoffControl: vi.fn(async () => ({ controlVersion: 1, programId: program.programId, programRevision: 4, programEpoch: 2,
      state: "live", handoffPending: false, writer: { packagerId, fencingRevision: 4 } })),
    stopProgram: vi.fn(async () => {}), stopNativeAssignment: vi.fn(async () => {}), confirmNativeProgramStopped: vi.fn(async () => {}) };
  const handoff = vi.fn(async () => { throw new Error("lost handoff response"); });
  Object.assign(control, { prepareNativeSourceHandoff: handoff });
  const service = new NativeSourceProgramService({ claims } as never, { value: config } as never,
    { fingerprint: () => "a".repeat(43) } as never, room as never, mesh as never, signaling as never,
    { eligible: () => candidates() } as never, control as never);
  return { service, room, mesh, signaling, config, claims, candidates, control, handoff };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("retains only the last own program for history after stop, never after a membership generation change", async () => {
  const f = fixture();
  try {
    expect(f.service.historyContext()).toBeNull();
    await f.service.controller.start(request, "user-action");
    expect(f.service.historyContext()?.program.programId).toBe(program.programId);
    await f.service.controller.stop();
    expect(f.service.requestProgram()).toBeNull(); expect(f.service.historyContext()?.program.programId).toBe(program.programId);
    const calls = f.control.nativeHandoffControl.mock.calls.length;
    f.mesh.membershipEpoch.set(3); expect(f.service.historyContext()).toBeNull();
    await vi.advanceTimersByTimeAsync(250); f.mesh.membershipEpoch.set(2);
    expect(f.service.historyContext()).toBeNull(); expect(f.control.nativeHandoffControl).toHaveBeenCalledTimes(calls);
  } finally { f.service.ngOnDestroy(); }
});

it.each(["room", "epoch", "identity", "capability", "disconnect", "expiry", "destroy"])("fences a capacity reply after %s changes", async change => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  const preview = vi.fn(() => new Promise(done => { resolve = done; }));
  Object.assign(f.control, { nativeCapacityPreview: preview });
  try {
    expect(f.service.capacityContext(request)).not.toBeNull();
    const pending = f.service.previewCapacity(request, new AbortController().signal);
    if (change === "room") f.room.roomId.set("room-other");
    if (change === "epoch") f.mesh.membershipEpoch.set(3);
    if (change === "identity") f.claims.set({ ...f.claims(), sub: "other" });
    if (change === "capability") f.candidates.set([]);
    if (change === "disconnect") f.signaling.status.set("closed");
    if (change === "expiry") vi.setSystemTime(NOW + 301000);
    if (change === "destroy") f.service.ngOnDestroy();
    resolve({ syntheticObservation: true });
    await expect(pending).rejects.toThrow("native_capacity_preview_stale");
    expect(f.control.createProgram).not.toHaveBeenCalled();
    expect(f.control.prepareNativeSourceStart).not.toHaveBeenCalled();
  } finally { f.service.ngOnDestroy(); }
});

it("passes a current capacity observation without creating a program and refuses a foreign room before HTTP", async () => {
  const f = fixture(), result = { syntheticObservation: true }, preview = vi.fn(async () => result);
  Object.assign(f.control, { nativeCapacityPreview: preview });
  try {
    const abort = new AbortController();
    expect(await f.service.previewCapacity(request, abort.signal)).toBe(result);
    expect(preview).toHaveBeenCalledExactlyOnceWith(request, abort.signal);
    await expect(f.service.previewCapacity({ ...request, roomId: "room-other" }, abort.signal)).rejects.toThrow();
    expect(preview).toHaveBeenCalledTimes(1); expect(f.control.createProgram).not.toHaveBeenCalled();
  } finally { f.service.ngOnDestroy(); }
});

it("pins hardware/rendition choices and checks every assignment after a lost handoff response", async () => {
  const f = fixture(), next = "pkr_bbbbbbbbbbbbbbbb";
  try {
    f.candidates.set([...f.candidates(), { ...f.candidates()[0], id: next }]);
    await f.service.controller.start(request, "user-action");
    f.control.confirmNativeProgramStopped.mockRejectedValueOnce(new Error("unknown successor still draining"));
    await f.service.controller.handoff(next, "user-action");
    expect(f.handoff).toHaveBeenCalledWith({ ...prepared, programRevision: 4 }, expect.objectContaining({ programRevision: 4 }),
      next, 1, false, "user-action", expect.any(AbortSignal));
    expect(f.control.stopNativeAssignment).toHaveBeenCalledWith(assignment, expect.any(AbortSignal));
    expect(f.control.confirmNativeProgramStopped).toHaveBeenCalledWith(program.programId, expect.any(AbortSignal));
    expect(f.service.view()).toMatchObject({ active: true, error: "native_source_program_stop_unconfirmed" });
    await f.service.controller.stop(); expect(f.service.view().active).toBe(false);
  } finally { f.service.ngOnDestroy(); }
});

for (const capabilityVersion of [5, 6]) it(`carries selected output to HTTP with capability v${capabilityVersion}, audio v3 and stops on downgrade`, async () => {
  const f = fixture();
  const capability = { ...f.candidates()[0].capability, capabilityVersion, sourceAudioControlVersion: 3, sourceAudioEncodingVersion: 1,
    ...(capabilityVersion === 6 ? { sourceSceneControlVersion: 2 } : {}) };
  const audioOutput = { codec: "aac" as const, sampleRate: 48000 as const, channels: 1 as const, targetBitsPerSecond: 48000 };
  try {
    await expect(f.service.controller.start({ ...request, audioOutput }, "user-action")).rejects.toThrow();
    expect(f.control.createProgram).not.toHaveBeenCalled();
    f.candidates.set([{ id: packagerId, capability }]);
    await f.service.controller.start({ ...request, audioOutput }, "user-action");
    expect(f.control.prepareNativeSourceStart).toHaveBeenCalledWith(program, packagerId, 1, false, "user-action", expect.any(AbortSignal), audioOutput, undefined);
    expect(f.service.audioContext()?.audioControlVersion).toBe(3);
    f.candidates.set([{ id: packagerId, capability: { ...capability, sourceAudioEncodingVersion: 2 } }]);
    expect(f.service.audioContext()).toBeNull(); await vi.advanceTimersByTimeAsync(250);
    expect(f.control.stopProgram).toHaveBeenCalledOnce(); expect(f.control.stopNativeAssignment).toHaveBeenCalledOnce();
    expect(f.service.view().active).toBe(false);
  } finally { f.service.ngOnDestroy(); }
});

it("audio context requires the current controlled packager's explicit v3 capability", async () => {
  const f = fixture();
  try {
    expect(f.service.audioContext()).toBeNull();
    await f.service.controller.start(request, "user-action");
    expect(f.service.audioContext()).toBeNull();
    const capability = { ...f.candidates()[0].capability, capabilityVersion: 3, sourceAudioControlVersion: 1 };
    f.candidates.set([{ id: packagerId, capability }]);
    expect(f.service.audioContext()?.program.programId).toBe(program.programId);
    expect(f.service.audioContext()?.audioControlVersion).toBe(1);
    f.candidates.set([{ id: packagerId, capability: { ...capability, capabilityVersion: 4, sourceAudioControlVersion: 2 } }]);
    expect(f.service.audioContext()?.audioControlVersion).toBe(2);
    f.candidates.set([{ id: packagerId, capability: { ...capability, capabilityVersion: 4, sourceAudioControlVersion: 1 } }]);
    expect(f.service.audioContext()).toBeNull();
    f.candidates.set([{ id: "pkr_bbbbbbbbbbbbbbbb", capability }]);
    expect(f.service.audioContext()).toBeNull();
  } finally { f.service.ngOnDestroy(); }
});

it("composes bounded HTTP control only, exposes the confirmed source reference, and stops both endpoints", async () => {
  const f = fixture();
  try {
    expect(f.control.createProgram).not.toHaveBeenCalled(); expect(f.service.requestProgram()).toBeNull();
    await f.service.controller.start(request, "user-action");
    expect(f.control.createProgram).toHaveBeenCalledWith("room-alpha", "Studio", "private", expect.any(AbortSignal));
    expect(f.control.prepareNativeSourceStart).toHaveBeenCalledWith(program, packagerId, 1, false, "user-action", expect.any(AbortSignal), undefined, undefined);
    expect(f.service.requestProgram()).toEqual({ ...prepared, programRevision: 4 });
    f.control.stopProgram.mockRejectedValueOnce(new Error("revocation unavailable")); await f.service.controller.stop();
    expect(f.control.stopNativeAssignment).toHaveBeenCalledWith(assignment, expect.any(AbortSignal));
    expect(f.service.view()).toMatchObject({ active: true, error: "native_source_program_stop_unconfirmed" });
    await f.service.controller.stop(); expect(f.service.view().active).toBe(false);
  } finally { f.service.ngOnDestroy(); }
  // Native AbortSignal.timeout deadlines remain bounded after their operations;
  // unlike the owned poll interval they expire without another control request.
  const calls = f.control.nativeHandoffControl.mock.calls.length;
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.control.nativeHandoffControl).toHaveBeenCalledTimes(calls);
  expect(vi.getTimerCount()).toBe(0);
});

for (const reason of ["creator", "machine", "expired", "claims", "disabled", "connection", "peer", "epoch", "capability"]) {
  it(`denies ${reason} and retains current room authority`, async () => {
    const f = fixture();
    try {
      if (reason === "creator") f.room.roomCreator.set(false);
      if (reason === "machine") f.room.machineExpiresAt.set(NOW + 5000);
      if (reason === "expired") f.claims.set({ ...f.claims(), exp: NOW / 1000 });
      if (reason === "claims") f.claims.set({ ...f.claims(), sub: "x".repeat(1025) });
      if (reason === "disabled") f.config.set({ nativePackagers: { publicationEnabled: false } });
      if (reason === "connection") f.signaling.status.set("disconnected");
      if (reason === "peer") f.mesh.ownPeerId.set("fedcba9876543210");
      if (reason === "epoch") f.mesh.membershipEpoch.set(0);
      if (reason === "capability") f.candidates.set([{ id: packagerId, capability: { capabilityVersion: 1, sourcePrograms: true, maximumRenditions: 3 } }]);
      await expect(f.service.controller.start(request, "user-action")).rejects.toThrow("start_denied");
      expect(f.control.createProgram).not.toHaveBeenCalled();
    } finally { f.service.ngOnDestroy(); }
  });
}

it("stops on identity or membership generation loss even after the panel is gone", async () => {
  const f = fixture();
  try {
    await f.service.controller.start(request, "user-action"); f.mesh.membershipEpoch.set(3);
    await vi.advanceTimersByTimeAsync(250);
    expect(f.control.stopProgram).toHaveBeenCalledOnce(); expect(f.control.stopNativeAssignment).toHaveBeenCalledOnce();
    expect(f.service.requestProgram()).toBeNull();
  } finally { f.service.ngOnDestroy(); }
});

it("requires native inventory confirmation even when the prepare response is lost", async () => {
  const f = fixture();
  try {
    f.control.prepareNativeSourceStart.mockRejectedValueOnce(new Error("response lost"));
    f.control.confirmNativeProgramStopped.mockRejectedValueOnce(new Error("still draining"));
    await f.service.controller.start(request, "user-action");
    expect(f.control.stopProgram).toHaveBeenCalledOnce();
    expect(f.control.confirmNativeProgramStopped).toHaveBeenCalledWith(program.programId, expect.any(AbortSignal));
    expect(f.service.view()).toMatchObject({ active: true, error: "native_source_program_stop_unconfirmed" });
    await f.service.controller.stop(); expect(f.service.view().active).toBe(false);
  } finally { f.service.ngOnDestroy(); }
});
