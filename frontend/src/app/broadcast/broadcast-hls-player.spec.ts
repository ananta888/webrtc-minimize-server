import { afterEach, describe, expect, it, vi } from "vitest";

import { BroadcastHlsPlayer } from "./broadcast-hls-player";

function video(nativeHls = false): HTMLVideoElement {
  const element = document.createElement("video");
  Object.defineProperties(element, {
    canPlayType: { value: vi.fn(() => nativeHls ? "probably" : "") },
    play: { value: vi.fn(async () => undefined), configurable: true },
    pause: { value: vi.fn() },
    load: { value: vi.fn() },
    readyState: { value: 4, configurable: true },
    paused: { value: false, configurable: true },
    ended: { value: false, configurable: true },
    seekable: { value: { length: 1, start: () => 0, end: () => 12 }, configurable: true },
  });
  return element;
}

class FakeHls {
  static instances: FakeHls[] = [];
  static autoManifest = true;
  static supported = true;
  static isSupported(): boolean { return FakeHls.supported; }
  readonly levels = [
    { height: 360, bitrate: 564_000 },
    { height: 720, bitrate: 2_528_000 },
  ];
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  currentLevel = -1;
  nextLevel = -1;
  bandwidthEstimate = 8_000_000;
  liveSyncPosition: number | null = 10;
  attached: HTMLMediaElement | null = null;
  source = "";
  stopLoad = vi.fn();
  startLoad = vi.fn();
  recoverMediaError = vi.fn();
  destroy = vi.fn();

  constructor(_config: unknown) { FakeHls.instances.push(this); }
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) || []), listener]);
  }
  attachMedia(media: HTMLMediaElement): void { this.attached = media; }
  loadSource(source: string): void {
    this.source = source;
    if (FakeHls.autoManifest) queueMicrotask(() => this.emit("hlsManifestParsed"));
  }
  off(event: string, listener: (...args: unknown[]) => void): void {
    this.handlers.set(event, (this.handlers.get(event) || []).filter((candidate) => candidate !== listener));
  }
  emit(event: string, data: unknown = {}): void {
    for (const listener of this.handlers.get(event) || []) listener(event, data);
  }
}

const fakeModule = {
  default: FakeHls,
  Events: { MANIFEST_PARSED: "hlsManifestParsed", LEVEL_SWITCHED: "hlsLevelSwitched", ERROR: "hlsError" },
};

describe("BroadcastHlsPlayer", () => {
  it("bounds a non-cooperative engine load without fetching media or silently choosing native HLS", async () => {
    vi.useFakeTimers();
    FakeHls.instances = [];
    const loader = vi.fn(() => new Promise<never>(() => {})), element = video(true);
    const player = new BroadcastHlsPlayer(() => undefined, loader);
    let settled = false, failure: unknown;
    const pending = player.open(element, "/broadcast/play/res_aaaaaaaaaaaaaaaa/index.m3u8", { muted: true, volume: 1 }, new AbortController().signal)
      .catch(error => { settled = true; failure = error; });
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(settled).toBe(true);
      await pending; expect(failure).toMatchObject({ code: "broadcast_player_engine_unavailable" });
      expect(player.snapshot()).toMatchObject({ lifecycle: "failed", engine: null });
      expect(loader).toHaveBeenCalledTimes(1); expect(FakeHls.instances).toHaveLength(0);
      expect(element.getAttribute("src")).toBe(null); expect(element.play).not.toHaveBeenCalled();
    } finally { await player.destroy(); vi.useRealTimers(); }
  });
  it.each(["abort", "destroy"])("settles a hung loader immediately on %s and ignores its late completion", async action => {
    vi.useFakeTimers(); FakeHls.instances = [];
    let release!: (module: unknown) => void;
    const loader = vi.fn((_signal?: AbortSignal) => new Promise<never>(resolve => { release = resolve as never; }));
    const controller = new AbortController(), element = video(), player = new BroadcastHlsPlayer(() => undefined, loader);
    let settled = false;
    const pending = player.open(element, "/broadcast/play/res_aaaaaaaaaaaaaaaa/index.m3u8", { muted: true, volume: 1 }, controller.signal)
      .catch(error => { settled = true; expect(error).toMatchObject({ name: "AbortError" }); });
    try {
      if (action === "abort") controller.abort(); else await player.destroy();
      await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(true); await pending;
      expect(loader.mock.calls[0][0]?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
      release(fakeModule); await vi.advanceTimersByTimeAsync(6000);
      expect(FakeHls.instances).toHaveLength(0); expect(element.play).not.toHaveBeenCalled();
      expect(player.snapshot().lifecycle).toBe("idle"); expect(loader).toHaveBeenCalledTimes(1);
    } finally { await player.destroy(); vi.useRealTimers(); }
  });
  it.each([1000, 4900])("keeps retries inside one five-second budget when the first attempt fails at %i ms", async failAt => {
    vi.useFakeTimers();
    let rejectFirst!: (reason: unknown) => void;
    const loader = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }))
      .mockImplementation(() => new Promise(() => {}));
    const player = new BroadcastHlsPlayer(() => undefined, loader);
    let settled = false;
    const pending = player.open(video(), "/broadcast/play/res_aaaaaaaaaaaaaaaa/index.m3u8", { muted: true, volume: 1 }, new AbortController().signal)
      .catch(error => { settled = true; expect(error).toMatchObject({ code: "broadcast_player_engine_unavailable" }); });
    try {
      await vi.advanceTimersByTimeAsync(failAt); rejectFirst(new Error("synthetic-private-detail"));
      await vi.advanceTimersByTimeAsync(4999 - failAt); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(settled).toBe(true); await pending;
      expect(loader).toHaveBeenCalledTimes(failAt === 1000 ? 2 : 1);
      expect(player.snapshot().errorCode).toBe("broadcast_player_engine_unavailable"); expect(vi.getTimerCount()).toBe(0);
    } finally { await player.destroy(); vi.useRealTimers(); }
  });
  it("does not retry an obsolete generation during the retry delay", async () => {
    vi.useFakeTimers();
    const loader = vi.fn().mockRejectedValue(new Error("synthetic-private-detail"));
    const player = new BroadcastHlsPlayer(() => undefined, loader);
    const pending = player.open(video(), "/broadcast/play/res_aaaaaaaaaaaaaaaa/index.m3u8", { muted: true, volume: 1 }, new AbortController().signal)
      .catch(error => expect(error).toMatchObject({ name: "AbortError" }));
    try {
      await vi.advanceTimersByTimeAsync(100); await player.destroy(); await pending;
      await vi.advanceTimersByTimeAsync(10000); expect(loader).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    } finally { await player.destroy(); vi.useRealTimers(); }
  });
  it("does not let old abort signals or old HLS events terminate a newer output", async () => {
    FakeHls.instances = [];
    const controller = new AbortController(), element = video();
    const player = new BroadcastHlsPlayer(() => undefined, async () => fakeModule as never);
    await player.open(element, "/broadcast/play/res_aaaaaaaaaaaaaaaa/index.m3u8", { muted: true, volume: 1 }, controller.signal);
    const old = FakeHls.instances[0];
    await player.destroy();
    await player.open(element, "/broadcast/play/res_bbbbbbbbbbbbbbbb/index.m3u8", { muted: true, volume: 1 }, new AbortController().signal);
    controller.abort();
    old.emit("hlsError", { type: "networkError", fatal: true, response: { code: 403 } });
    expect(player.snapshot().lifecycle).toBe("playing");
    expect(FakeHls.instances[1].destroy).not.toHaveBeenCalled();
    await player.destroy();
  });

  it("does not attach or clean a successor after a retired engine load completes", async () => {
    FakeHls.instances = [];
    let release!: (value: unknown) => void;
    const loader = vi.fn().mockReturnValueOnce(new Promise((resolve) => { release = resolve; })).mockResolvedValueOnce(fakeModule);
    const player = new BroadcastHlsPlayer(() => undefined, loader), element = video();
    const pending = player.open(element, "/broadcast/play/res_aaaaaaaaaaaaaaaa/index.m3u8", { muted: true, volume: 1 }, new AbortController().signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(DOMException);
    await player.destroy();
    await player.open(element, "/broadcast/play/res_bbbbbbbbbbbbbbbb/index.m3u8", { muted: true, volume: 1 }, new AbortController().signal);
    release(fakeModule);
    await rejected;
    expect(FakeHls.instances).toHaveLength(1);
    expect(player.snapshot().lifecycle).toBe("playing");
    expect(FakeHls.instances[0].destroy).not.toHaveBeenCalled();
    await player.destroy();
  });
  afterEach(() => {
    FakeHls.autoManifest = true;
    FakeHls.supported = true;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });
  it("falls back to native HLS without MSE and treats autoplay denial as a visible user-action state", async () => {
    const element = video(true);
    Object.defineProperty(element, "play", {
      value: vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }),
    });
    FakeHls.supported = false;
    const player = new BroadcastHlsPlayer(() => undefined, async () => fakeModule as never);
    await player.open(element, "/broadcast/play/res_aaaaaaaaaaaaaaaa/index.m3u8", {
      muted: false, volume: 0.7,
    }, new AbortController().signal);
    expect(player.snapshot()).toMatchObject({ engine: "native-hls", lifecycle: "awaiting-user" });
    expect(element.src).toBe(`${location.origin}/broadcast/play/res_aaaaaaaaaaaaaaaa/index.m3u8`);
    await player.destroy();
    expect(element.getAttribute("src")).toBeNull();
    expect(element.load).toHaveBeenCalled();
  });

  it("prefers hls.js over a browser's incomplete native HLS claim", async () => {
    FakeHls.instances = [];
    const element = video(true);
    const player = new BroadcastHlsPlayer(() => undefined, async () => fakeModule as never);
    await player.open(element, "/broadcast/play/res_ffffffffffffffff/index.m3u8", {
      muted: true, volume: 1,
    }, new AbortController().signal);
    expect(player.snapshot()).toMatchObject({ engine: "hls-js", lifecycle: "playing" });
    expect(FakeHls.instances).toHaveLength(1);
    expect(element.getAttribute("src")).toBeNull();
    await player.destroy();
  });

  it("retries one transient same-origin player-module load and then fails with a bounded code", async () => {
    const element = video(false);
    const recoveredLoader = vi.fn()
      .mockRejectedValueOnce(new TypeError("network changed with private URL details"))
      .mockResolvedValueOnce(fakeModule as never);
    const recovered = new BroadcastHlsPlayer(() => undefined, recoveredLoader);
    await recovered.open(element, "/broadcast/play/res_3333333333333333/index.m3u8", {
      muted: true, volume: 1,
    }, new AbortController().signal);
    expect(recoveredLoader).toHaveBeenCalledTimes(2);
    expect(recovered.snapshot()).toMatchObject({ lifecycle: "playing", engine: "hls-js" });
    await recovered.destroy();

    const failedLoader = vi.fn(async () => { throw new TypeError("secret network detail"); });
    const failed = new BroadcastHlsPlayer(() => undefined, failedLoader);
    await expect(failed.open(video(false), "/broadcast/play/res_4444444444444444/index.m3u8", {
      muted: true, volume: 1,
    }, new AbortController().signal)).rejects.toThrow("broadcast_player_engine_unavailable");
    expect(failedLoader).toHaveBeenCalledTimes(2);
    expect(failed.snapshot()).toMatchObject({
      lifecycle: "failed", errorCode: "broadcast_player_engine_unavailable",
    });
    await failed.destroy();
  });

  it("uses pinned hls.js for MSE, offers quality selection and destroys every handle", async () => {
    FakeHls.instances = [];
    const states: string[] = [];
    const element = video(false);
    let player!: BroadcastHlsPlayer;
    Object.defineProperty(element, "play", {
      configurable: true,
      value: vi.fn(async () => {
        expect(FakeHls.instances[0].source).toContain("/broadcast/play/");
        expect(player.snapshot().qualities).toHaveLength(2);
      }),
    });
    player = new BroadcastHlsPlayer(
      (state) => states.push(state.lifecycle),
      async () => fakeModule as never,
    );
    await player.open(element, "/broadcast/play/res_bbbbbbbbbbbbbbbb/master.m3u8", {
      muted: true, volume: 1,
    }, new AbortController().signal);
    const hls = FakeHls.instances[0];
    expect(player.snapshot().qualities.map(({ label }) => label)).toEqual(["360p", "720p"]);
    player.selectQuality(1);
    expect(hls.currentLevel).toBe(1);
    player.adaptQuality({ sampledAt: 20_000, bandwidthEstimateBitsPerSecond: 100_000,
      bufferSeconds: 0, decodedFrames: 50, droppedFrames: 50, lowPowerMode: true });
    expect(hls.nextLevel).toBe(-1);
    player.selectQuality("auto");
    expect(hls.currentLevel).toBe(-1);
    player.setAdaptiveMode("data-saver");
    player.adaptQuality({ sampledAt: 20_000, bandwidthEstimateBitsPerSecond: 8_000_000,
      bufferSeconds: 8, decodedFrames: 300, droppedFrames: 0, lowPowerMode: false });
    expect(hls.nextLevel).toBe(0);
    expect(player.snapshot()).toMatchObject({ adaptiveMode: "data-saver", adaptationReason: "data-saver" });
    expect(states).toContain("playing");
    await player.destroy();
    expect(hls.stopLoad).toHaveBeenCalledOnce();
    expect(hls.destroy).toHaveBeenCalledOnce();
  });

  it("fails closed when the hls.js manifest reports a fatal startup error", async () => {
    FakeHls.instances = [];
    FakeHls.autoManifest = false;
    const element = video(false);
    const player = new BroadcastHlsPlayer(() => undefined, async () => fakeModule as never);
    const opening = player.open(element, "/broadcast/play/res_eeeeeeeeeeeeeeee/index.m3u8", {
      muted: true, volume: 1,
    }, new AbortController().signal);
    await vi.waitFor(() => expect(FakeHls.instances).toHaveLength(1));
    FakeHls.instances[0].emit("hlsError", { fatal: true, type: "networkError" });
    await expect(opening).rejects.toThrow("broadcast_player_manifest_unavailable");
    expect(player.snapshot()).toMatchObject({
      lifecycle: "failed", errorCode: "broadcast_player_manifest_unavailable",
    });
    await player.destroy();
  });

  it("bounds fatal recovery and rejects token-bearing or foreign-shaped manifests", async () => {
    FakeHls.instances = [];
    const element = video(false);
    const player = new BroadcastHlsPlayer(() => undefined, async () => fakeModule as never);
    await expect(player.open(element,
      "/broadcast/play/res_aaaaaaaaaaaaaaaa/index.m3u8?access_token=secret",
      { muted: true, volume: 1 }, new AbortController().signal,
    )).rejects.toThrow("invalid_broadcast_manifest_url");
    await player.open(element, "/broadcast/play/res_cccccccccccccccc/index.m3u8", {
      muted: true, volume: 1,
    }, new AbortController().signal);
    const hls = FakeHls.instances[0];
    hls.emit("hlsError", { fatal: true, type: "networkError" });
    hls.emit("hlsError", { fatal: true, type: "networkError" });
    hls.emit("hlsError", { fatal: true, type: "networkError" });
    await Promise.resolve();
    expect(hls.startLoad).toHaveBeenCalledTimes(2);
    expect(hls.stopLoad).toHaveBeenCalledOnce();
    expect(player.snapshot()).toMatchObject({ lifecycle: "failed", recoveryCount: 2, errorCode: "broadcast_player_recovery_exhausted" });
    await player.destroy();
  });

  it("stops loading terminal revocation and rate-limit responses instead of retrying", async () => {
    FakeHls.instances = [];
    const endedPlayer = new BroadcastHlsPlayer(() => undefined, async () => fakeModule as never);
    await endedPlayer.open(video(false), "/broadcast/play/res_1111111111111111/index.m3u8", {
      muted: true, volume: 1,
    }, new AbortController().signal);
    const endedHls = FakeHls.instances[0];
    endedHls.emit("hlsError", { fatal: false, type: "networkError", response: { code: 404 } });
    expect(endedHls.stopLoad).toHaveBeenCalledOnce();
    expect(endedHls.startLoad).not.toHaveBeenCalled();
    expect(endedPlayer.snapshot()).toMatchObject({ lifecycle: "ended", errorCode: "broadcast_ended" });
    await endedPlayer.destroy();

    const limitedPlayer = new BroadcastHlsPlayer(() => undefined, async () => fakeModule as never);
    await limitedPlayer.open(video(false), "/broadcast/play/res_2222222222222222/index.m3u8", {
      muted: true, volume: 1,
    }, new AbortController().signal);
    const limitedHls = FakeHls.instances[1];
    limitedHls.emit("hlsError", { fatal: false, type: "networkError", response: { code: 429 } });
    expect(limitedHls.stopLoad).toHaveBeenCalledOnce();
    expect(limitedHls.startLoad).not.toHaveBeenCalled();
    expect(limitedPlayer.snapshot()).toMatchObject({
      lifecycle: "failed", errorCode: "broadcast_player_rate_limited",
    });
    await limitedPlayer.destroy();
  });

  it("polls the same protected playback scope for bounded live WebVTT and revokes it on destroy", async () => {
    const element = video(true);
    const vtt = "WEBVTT\n\ncc-1\n00:00:01.000 --> 00:00:02.000\nHallo\n";
    const fetchMock = vi.fn(async () => new Response(vtt, { status: 200, headers: { "content-type": "text/vtt; charset=utf-8" } }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:caption-live") });
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    const player = new BroadcastHlsPlayer();
    await player.open(element, "/broadcast/play/res_dddddddddddddddd/index.m3u8", {
      muted: true, volume: 1, captions: true,
    }, new AbortController().signal);
    await vi.waitFor(() => expect(element.querySelector("track[data-broadcast-player]")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      `${location.origin}/broadcast/play/res_dddddddddddddddd/captions_live.vtt`,
      expect.objectContaining({ credentials: "same-origin", cache: "no-store", redirect: "error" }),
    );
    player.setCaptionsVisible(true);
    await player.destroy();
    expect(element.querySelector("track[data-broadcast-player]")).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:caption-live");
  });
});
