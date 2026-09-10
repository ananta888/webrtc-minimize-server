import { describe, expect, it, vi } from "vitest";
import { NativeSourceProgramController, NativeSourceProgramView } from "./native-source-program-controller";
import type { NativePackagerHandoffControl } from "./native-packager-handoff-control";

const request = { roomId: "room-alpha", title: "Studio", visibility: "private" as const,
  packagerId: "pkr_aaaaaaaaaaaaaaaa", requestedRenditions: 1, allowHardwareAcceleration: false };
const program = { tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: request.roomId, programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 1, programEpoch: 1 };
const prepared = { ...program, programRevision: 3, programEpoch: 2 };
const assignment = { assignmentId: "asn_aaaaaaaaaaaaaaaa", packagerId: request.packagerId, programId: program.programId,
  programEpoch: 2, fencingRevision: 4, expiresAt: 90000 };
const snapshot: NativePackagerHandoffControl = { controlVersion: 1, programId: program.programId, programRevision: 4,
  programEpoch: 2, state: "preparing", handoffPending: false, writer: { packagerId: request.packagerId, fencingRevision: 4 } };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let now = 10000, context: string | null = "owner-room-epoch", eligible = true;
  const views: NativeSourceProgramView[] = [];
  const ports = { context: () => context, eligible: () => eligible, clock: () => now,
    create: vi.fn(async () => program), prepare: vi.fn(async () => ({ program: prepared, assignment })),
    observe: vi.fn(async (): Promise<NativePackagerHandoffControl> => snapshot), stop: vi.fn(async () => {}),
    changed: (v: NativeSourceProgramView) => views.push(v) };
  const controller = new NativeSourceProgramController(ports);
  return { controller, ports, views, view: () => views.at(-1)!, advance: (ms: number) => { now += ms; },
    context: (v: string | null) => { context = v; }, eligible: (v: boolean) => { eligible = v; } };
}

describe("native source program control-only lifecycle", () => {
  it("exposes only the pinned live output for keyless standby admission", async () => {
    const f = fixture();
    expect(f.controller.standbyOutput()).toBeNull();
    f.ports.observe.mockResolvedValue({ ...snapshot, state: "live" });
    const input = { ...request, requestedRenditions: 2 };
    await f.controller.start(input, "user-action");
    input.requestedRenditions = 3; input.allowHardwareAcceleration = true;
    const output = f.controller.standbyOutput();
    expect(output).toEqual({ requestedRenditions: 2, allowHardwareAcceleration: false });
    expect(Object.isFrozen(output)).toBe(true);
    f.context("other-owner"); expect(f.controller.standbyOutput()).toBeNull();
    await f.controller.stop(); expect(f.controller.standbyOutput()).toBeNull();
  });
  for (const reason of ["stop", "destroy", "context", "replacement"]) {
    it(`fences ${reason} during lazy request loading before any creation`, async () => {
      const f = fixture(), pending = f.controller.start(request, "user-action");
      const rejected = expect(pending).rejects.toThrow("start_denied");
      if (reason === "stop") await f.controller.stop();
      if (reason === "destroy") f.controller.destroy();
      if (reason === "context") f.context("other-room");
      const replacement = reason === "replacement" ? f.controller.start({ ...request, title: "New explicit choice" }, "user-action") : null;
      await rejected;
      if (replacement) {
        await replacement;
        expect(f.ports.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: "New explicit choice" }), expect.any(AbortSignal));
        await f.controller.stop();
      } else {
        expect(f.ports.create).not.toHaveBeenCalled(); expect(f.ports.prepare).not.toHaveBeenCalled();
      }
    });
  }
  it("pins a deep immutable output choice before asynchronous creation and rechecks support before prepare", async () => {
    const f = fixture(), pending = deferred<typeof program>();
    f.ports.create.mockReturnValue(pending.promise);
    const audioOutput = { codec: "aac" as const, sampleRate: 48000 as const, channels: 1 as 1 | 2, targetBitsPerSecond: 48000 };
    const start = f.controller.start({ ...request, audioOutput }, "user-action");
    audioOutput.channels = 2; audioOutput.targetBitsPerSecond = 192000;
    pending.resolve(program); await start;
    const passed = (f.ports.prepare.mock.calls as unknown as [unknown, { audioOutput: unknown }][])[0][1].audioOutput;
    expect(passed).toEqual({ codec: "aac", sampleRate: 48000, channels: 1, targetBitsPerSecond: 48000 });
    expect(Object.isFrozen(passed)).toBe(true); await f.controller.stop();
    const g = fixture(), creation = deferred<typeof program>(), created = deferred<void>();
    g.ports.create.mockImplementation(() => { created.resolve(); return creation.promise; });
    const next = g.controller.start({ ...request, audioOutput }, "user-action");
    await created.promise; g.eligible(false); creation.resolve(program); await next;
    expect(g.ports.prepare).not.toHaveBeenCalled(); expect(g.ports.stop).toHaveBeenCalledOnce();
  });
  it("rejects present undefined/null/invalid output before creating any program", async () => {
    const f = fixture();
    for (const audioOutput of [undefined, null, {}, { codec: "opus", sampleRate: 48000, channels: 1, targetBitsPerSecond: 48000 }]) {
      await expect(f.controller.start({ ...request, audioOutput } as never, "user-action")).rejects.toThrow();
    }
    expect(f.ports.create).not.toHaveBeenCalled();
  });
  it("does nothing on construction and accepts only an explicit closed request", async () => {
    const f = fixture(); f.controller.tick(); expect(f.ports.create).not.toHaveBeenCalled();
    for (const bad of [{ ...request, sourceIds: [] }, { ...request, roomId: "../bad" }, { ...request, requestedRenditions: 4 },
      { ...request, title: "\n" }, { ...request, allowHardwareAcceleration: "true" }]) {
      await expect(f.controller.start(bad as never, "user-action")).rejects.toThrow("start_denied");
    }
    await expect(f.controller.start(request, "remote")).rejects.toThrow("start_denied");
    f.context(null); await expect(f.controller.start(request, "user-action")).rejects.toThrow("start_denied");
    expect(f.ports.create).not.toHaveBeenCalled();
  });

  it("distinguishes accepted start from output confirmation and advances only matching revisions", async () => {
    const f = fixture(); await f.controller.start(request, "user-action");
    expect(f.view()).toMatchObject({ phase: "waiting-output", active: true, program: { programRevision: 4 } });
    await expect(f.controller.start(request, "user-action")).rejects.toThrow("start_denied");
    f.ports.observe.mockResolvedValue({ ...snapshot, state: "live", programRevision: 5 });
    f.advance(2000); f.controller.tick(); await flush();
    expect(f.view()).toMatchObject({ phase: "live", program: { programRevision: 5 } });
    f.ports.observe.mockResolvedValue({ ...snapshot, state: "degraded", programRevision: 6 });
    f.advance(2000); f.controller.tick(); await flush(); expect(f.view().phase).toBe("degraded");
    await f.controller.stop(); expect(f.ports.stop).toHaveBeenCalledExactlyOnceWith({ ...prepared, programRevision: 6 }, assignment);
    expect(f.view()).toMatchObject({ phase: "stopped", active: false, program: null });
  });

  for (const mutation of [{ programId: "prg_bbbbbbbbbbbbbbbb" }, { programEpoch: 3 }, { programRevision: 2 },
    { writer: null }, { writer: { ...snapshot.writer!, fencingRevision: 5 } },
    { writer: { ...snapshot.writer!, packagerId: "pkr_bbbbbbbbbbbbbbbb" } }, { handoffPending: true }, { state: "stopped" }]) {
    it(`rejects stale or changed writer ${JSON.stringify(mutation)}`, async () => {
      const f = fixture(); f.ports.observe.mockResolvedValue({ ...snapshot, ...mutation } as NativePackagerHandoffControl);
      await f.controller.start(request, "user-action");
      expect(f.view()).toMatchObject({ phase: "failed", active: false, error: "native_source_program_confirmation_lost" });
      expect(f.ports.stop).toHaveBeenCalledOnce(); expect(f.views.some(v => v.phase === "live")).toBe(false);
    });
  }

  for (const stage of ["create", "prepare"] as const) {
    it(`cleans a late ${stage} after explicit Stop without resurrecting it`, async () => {
      const f = fixture(), late = deferred<any>(); f.ports[stage].mockReturnValue(late.promise);
      const start = f.controller.start(request, "user-action"); await flush();
      const stop = f.controller.stop(); await flush();
      late.resolve(stage === "create" ? program : { program: prepared, assignment });
      await Promise.all([start, stop]);
      expect(f.view()).toMatchObject({ active: false, phase: "stopped", error: "" });
      expect(f.ports.stop).toHaveBeenCalledOnce(); expect(f.ports.observe).not.toHaveBeenCalled();
      if (stage === "create") expect(f.ports.prepare).not.toHaveBeenCalled();
    });
  }

  it("does not overlap status polls or revive a late live snapshot after context loss", async () => {
    const f = fixture(); await f.controller.start(request, "user-action");
    const late = deferred<NativePackagerHandoffControl>(); f.ports.observe.mockReturnValue(late.promise);
    f.advance(2000); f.controller.tick(); f.controller.tick(); expect(f.ports.observe).toHaveBeenCalledTimes(2);
    f.context("other-owner"); f.controller.tick(); await flush();
    expect(f.view()).toMatchObject({ active: false, program: null });
    late.resolve({ ...snapshot, state: "live" }); await flush(); expect(f.views.some(v => v.phase === "live")).toBe(false);
  });

  for (const reason of ["context", "eligibility", "clock", "missing-output", "stale-live"]) {
    it(`stops on ${reason} without automatic restart or consent`, async () => {
      const f = fixture();
      if (reason === "stale-live") f.ports.observe.mockResolvedValue({ ...snapshot, state: "live" });
      await f.controller.start(request, "user-action");
      if (reason === "context") f.context(null);
      if (reason === "eligibility") f.eligible(false);
      if (reason === "clock") f.advance(-1);
      if (reason === "missing-output") f.advance(45000);
      if (reason === "stale-live") f.advance(7000);
      f.controller.tick(); await flush();
      expect(f.view()).toMatchObject({ active: false, phase: "failed" });
      expect(f.ports.stop).toHaveBeenCalledOnce(); f.controller.tick(); expect(f.ports.create).toHaveBeenCalledOnce();
    });
  }

  it("retains an unconfirmed cleanup for manual retry and hides it after an identity change", async () => {
    const f = fixture(); await f.controller.start(request, "user-action");
    f.ports.stop.mockRejectedValueOnce(new Error("sensitive remote text")); await f.controller.stop();
    expect(f.view()).toMatchObject({ active: true, phase: "failed", error: "native_source_program_stop_unconfirmed" });
    await expect(f.controller.start(request, "user-action")).rejects.toThrow("start_denied");
    f.context("new-owner"); f.controller.tick(); expect(f.view().program).toBeNull();
    expect(JSON.stringify(f.views)).not.toContain("sensitive");
    await f.controller.stop(); expect(f.view().active).toBe(false); expect(f.ports.stop).toHaveBeenCalledTimes(2);
  });

  it("destroys the owned lifecycle, but not by constructing or hiding a UI component", async () => {
    const f = fixture(); await f.controller.start(request, "user-action"); f.controller.destroy(); await flush();
    expect(f.ports.stop).toHaveBeenCalledOnce();
    await expect(f.controller.start(request, "user-action")).rejects.toThrow("start_denied");
  });
});
