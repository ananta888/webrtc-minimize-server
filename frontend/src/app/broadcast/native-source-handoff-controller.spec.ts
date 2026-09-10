import { expect, it, vi } from "vitest";
import { NativeSourceProgramController, NativeSourceProgramView } from "./native-source-program-controller";
import type { NativePackagerHandoffControl } from "./native-packager-handoff-control";

const first = "pkr_aaaaaaaaaaaaaaaa", next = "pkr_bbbbbbbbbbbbbbbb";
const program = { tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "room-alpha", programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 3, programEpoch: 1 };
const assignment = { assignmentId: "asn_aaaaaaaaaaaaaaaa", packagerId: first, programId: program.programId,
  programEpoch: 1, fencingRevision: 4, expiresAt: 90000 };
const successor = { program: { ...program, programRevision: 7, programEpoch: 2 },
  assignment: { ...assignment, assignmentId: "asn_bbbbbbbbbbbbbbbb", packagerId: next, programEpoch: 2, fencingRevision: 6 } };
const snapshot: NativePackagerHandoffControl = { controlVersion: 1, programId: program.programId, programRevision: 5,
  programEpoch: 1, state: "live", handoffPending: false, writer: { packagerId: first, fencingRevision: 4 } };
const nextSnapshot: NativePackagerHandoffControl = { ...snapshot, programRevision: 8, programEpoch: 2,
  state: "preparing", writer: { packagerId: next, fencingRevision: 6 } };
const request = { roomId: program.roomId, title: "Studio", visibility: "private" as const, packagerId: first,
  requestedRenditions: 2, allowHardwareAcceleration: false,
  audioOutput: { codec: "aac" as const, sampleRate: 48000 as const, channels: 1 as const, targetBitsPerSecond: 48000 } };
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
async function fixture() {
  let now = 10000, context = "owner-room-epoch", allowed = true;
  const views: NativeSourceProgramView[] = [];
  const ports = { context: () => context, clock: () => now, eligible: vi.fn(() => allowed),
    create: vi.fn(async () => ({ ...program, programRevision: 1 })), prepare: vi.fn(async () => ({ program, assignment })),
    observe: vi.fn(async (): Promise<NativePackagerHandoffControl> => snapshot),
    handoff: vi.fn(async () => successor), stop: vi.fn(async () => {}), changed: (v: NativeSourceProgramView) => views.push(v) };
  const controller = new NativeSourceProgramController(ports); await controller.start(request, "user-action");
  return { controller, ports, views, view: () => views.at(-1)!, time: (ms: number) => { now += ms; },
    context: () => { context = "other-room"; }, revoke: () => { allowed = false; } };
}

it("uses a fresh matching CAS snapshot, pins output choices and waits for successor output", async () => {
  const f = await fixture(); expect(f.controller.canHandoff(next)).toBe(true);
  await expect(f.controller.handoff(first, "user-action")).rejects.toThrow("denied");
  await expect(f.controller.handoff(next, "remote")).rejects.toThrow("denied");
  f.ports.observe.mockResolvedValueOnce({ ...snapshot, programRevision: 6 }).mockResolvedValue(nextSnapshot);
  await f.controller.handoff(next, "user-action");
  expect(f.ports.handoff).toHaveBeenCalledExactlyOnceWith({ ...program, programRevision: 5 },
    { ...snapshot, programRevision: 6 }, { ...request, packagerId: next }, expect.any(AbortSignal));
  expect(f.view()).toMatchObject({ phase: "waiting-output", active: true, program: { programEpoch: 2 } });
  expect(f.controller.controlledPackagerId()).toBeNull(); expect(f.controller.canHandoff(first)).toBe(false);
  f.ports.observe.mockResolvedValue({ ...nextSnapshot, state: "live" }); f.time(2000); f.controller.tick(); await flush();
  expect(f.controller.controlledPackagerId()).toBe(next); expect(f.controller.canHandoff(first)).toBe(true);
  await f.controller.stop(); expect(f.ports.stop).toHaveBeenCalledWith({ ...successor.program, programRevision: 8 }, successor.assignment);
});

for (const outcome of ["late-live", "late-error"]) it(`discards an old poll's ${outcome} during the explicit handoff`, async () => {
  const f = await fixture(), old = deferred<NativePackagerHandoffControl>();
  f.ports.observe.mockReturnValueOnce(old.promise); f.time(2000); f.controller.tick();
  f.ports.observe.mockResolvedValueOnce(snapshot).mockResolvedValue(nextSnapshot);
  await f.controller.handoff(next, "user-action");
  if (outcome === "late-live") old.resolve(snapshot); else old.reject(new Error("old network result"));
  await flush(); expect(f.view().phase).toBe("waiting-output"); expect(f.ports.stop).not.toHaveBeenCalled();
  await f.controller.stop();
});

for (const reason of ["stop", "destroy", "context", "capability", "deadline"]) it(`fences ${reason} while a handoff reply is pending`, async () => {
  const f = await fixture(), late = deferred<typeof successor>(); f.ports.handoff.mockReturnValue(late.promise);
  const pending = f.controller.handoff(next, "user-action"); await flush();
  expect(f.view().phase).toBe("handing-over"); expect(f.controller.controlledPackagerId()).toBeNull();
  await expect(f.controller.handoff(next, "user-action")).rejects.toThrow("denied");
  const stopping = reason === "stop" ? f.controller.stop() : undefined;
  if (reason === "destroy") f.controller.destroy();
  if (reason === "context") f.context();
  if (reason === "capability") f.revoke();
  if (reason === "deadline") f.time(15000);
  f.controller.tick(); late.resolve(successor); await pending; await stopping; await flush();
  expect(f.view().active).toBe(false); expect(f.ports.stop).toHaveBeenCalledExactlyOnceWith(successor.program, successor.assignment);
  expect(f.views.filter(v => v.program?.programEpoch === 2 && v.phase === "live")).toHaveLength(0);
});

for (const change of [{ programEpoch: 2 }, { programRevision: 4 }, { handoffPending: true },
  { writer: { packagerId: next, fencingRevision: 4 } }, { state: "preparing" }]) it(`denies stale handoff ${JSON.stringify(change)}`, async () => {
  const f = await fixture(); f.ports.observe.mockResolvedValue({ ...snapshot, ...change });
  await f.controller.handoff(next, "user-action");
  expect(f.ports.handoff).not.toHaveBeenCalled(); expect(f.ports.stop).toHaveBeenCalledOnce();
  expect(f.view()).toMatchObject({ phase: "failed", active: false, error: "native_source_handoff_failed" });
});

it("retains failed cleanup after a lost handoff response for explicit retry", async () => {
  const f = await fixture(); f.ports.handoff.mockRejectedValueOnce(new Error("lost response"));
  f.ports.stop.mockRejectedValueOnce(new Error("successor still draining"));
  await f.controller.handoff(next, "user-action"); expect(f.view()).toMatchObject({ active: true, error: "native_source_program_stop_unconfirmed" });
  await f.controller.stop(); expect(f.view().active).toBe(false); expect(f.ports.create).toHaveBeenCalledOnce();
});
