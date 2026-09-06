import "@angular/compiler";
import { Injector, runInInjectionContext, signal } from "@angular/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BroadcastHlsPlayer } from "./broadcast-hls-player";
import { BroadcastPlayerComponent } from "./broadcast-player.component";

const url = "/broadcast/play/res_aaaaaaaaaaaaaaaa/index.m3u8";
const next = "/broadcast/play/res_bbbbbbbbbbbbbbbb/index.m3u8";
const instances: BroadcastPlayerComponent[] = [];
function fixture() {
  const opened = vi.spyOn(BroadcastHlsPlayer.prototype, "open").mockImplementation(async function () {
    Reflect.set(this, "hls", { currentLevel: -1 });
    Reflect.get(this, "update").call(this, { lifecycle: "playing", engine: "hls-js",
      qualities: [{ index: 0, height: 360, bitrate: 500_000, label: "360p" }, { index: 1, height: 720, bitrate: 2_400_000, label: "720p" }] });
  });
  const destroyed = vi.spyOn(BroadcastHlsPlayer.prototype, "destroy").mockImplementation(async function () {
    Reflect.get(this, "update").call(this, { lifecycle: "idle", qualities: [] });
  });
  const component = runInInjectionContext(Injector.create({ providers: [] }), () => new BroadcastPlayerComponent());
  const source = signal(url), program = signal("prg_aaaaaaaaaaaaaaaa"), suspended = signal(false);
  Object.assign(component, { manifestUrl: source, programId: program, suspended,
    video: signal({ nativeElement: document.createElement("video") }) });
  const started = vi.fn(), closed = vi.fn(), interrupted = vi.fn();
  component.started.subscribe(started); component.closed.subscribe(closed); component.interrupted.subscribe(interrupted);
  instances.push(component);
  return { component, source, program, suspended, opened, destroyed, started, closed, interrupted };
}

describe("Explicit player continuation across output generations", () => {
  afterEach(() => { for (const component of instances.splice(0)) component.ngOnDestroy(); vi.restoreAllMocks(); });

  it("never starts from input changes alone and preserves a playing user's controls across a same-program switch", async () => {
    const f = fixture();
    f.component.ngOnChanges({});
    f.source.set(next); f.component.ngOnChanges({});
    expect(f.opened).not.toHaveBeenCalled();
    f.source.set(url);
    await f.component.start();
    f.component.setMuted(false); f.component.setVolume("0.4");
    f.component.setAdaptiveMode("data-saver"); f.component.setQuality("1");
    const firstSignal = f.opened.mock.calls[0][3];
    f.suspended.set(true); f.component.ngOnChanges({});
    await Promise.resolve();
    expect(firstSignal.aborted).toBe(true);
    f.source.set(next); f.component.ngOnChanges({});
    expect(f.opened).toHaveBeenCalledOnce();
    f.suspended.set(false); f.component.ngOnChanges({});
    await vi.waitFor(() => expect(f.opened).toHaveBeenCalledTimes(2));
    expect(f.opened.mock.calls[1]).toEqual([expect.any(HTMLVideoElement), next,
      { muted: false, volume: 0.4, captions: false }, expect.any(AbortSignal)]);
    expect(f.component.state()).toMatchObject({ adaptiveMode: "data-saver", selectedQuality: 1 });
    expect(f.started).toHaveBeenCalledExactlyOnceWith(url);
    expect(f.closed).not.toHaveBeenCalled();
  });

  it("cannot automatically play a different program or restart after Stop", async () => {
    const f = fixture();
    await f.component.start();
    f.program.set("prg_bbbbbbbbbbbbbbbb"); f.source.set(next); f.component.ngOnChanges({});
    await Promise.resolve();
    expect(f.opened).toHaveBeenCalledOnce();
    await f.component.start();
    expect(f.opened).toHaveBeenCalledTimes(2);
    await f.component.stop();
    f.source.set(url); f.component.ngOnChanges({});
    expect(f.opened).toHaveBeenCalledTimes(2);
    expect(f.closed).toHaveBeenCalledOnce();
  });

  it("ignores an old engine's late error and a pending start's late completion", async () => {
    const f = fixture();
    await f.component.start();
    const old = f.opened.mock.instances[0];
    f.source.set(next); f.component.ngOnChanges({});
    await vi.waitFor(() => expect(f.opened).toHaveBeenCalledTimes(2));
    Reflect.get(old, "update").call(old, { lifecycle: "ended", errorCode: "broadcast_ended" });
    await Promise.resolve();
    expect(f.interrupted).not.toHaveBeenCalled();
    expect(f.component.state().lifecycle).toBe("playing");
    let release!: () => void;
    f.opened.mockImplementationOnce(async function () {
      await new Promise<void>((resolve) => { release = resolve; });
      Reflect.get(this, "update").call(this, { lifecycle: "playing" });
    });
    f.source.set(url); f.component.ngOnChanges({});
    await vi.waitFor(() => expect(f.opened).toHaveBeenCalledTimes(3));
    await f.component.stop();
    release();
    await Promise.resolve(); await Promise.resolve();
    expect(f.component.state().lifecycle).toBe("idle");
    expect(f.closed).toHaveBeenCalledOnce();
  });

  it("hidden pages stop and notify the parent, without automatic resumption on return", async () => {
    const f = fixture();
    await f.component.start();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(f.closed).toHaveBeenCalledOnce());
    expect(f.opened.mock.calls[0][3].aborted).toBe(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    f.source.set(next); f.component.ngOnChanges({});
    expect(f.opened).toHaveBeenCalledOnce();
  });

  it("requests fresh authorization once for the current failed output but never for rate limiting", async () => {
    const f = fixture();
    await f.component.start();
    const engine = f.opened.mock.instances[0];
    Reflect.get(engine, "update").call(engine, { lifecycle: "failed", errorCode: "broadcast_player_rate_limited" });
    await Promise.resolve(); expect(f.interrupted).not.toHaveBeenCalled();
    for (let index = 0; index < 2; index++) Reflect.get(engine, "update").call(engine, { lifecycle: "ended", errorCode: "broadcast_ended" });
    await Promise.resolve();
    expect(f.interrupted).toHaveBeenCalledExactlyOnceWith(url);
  });
});
