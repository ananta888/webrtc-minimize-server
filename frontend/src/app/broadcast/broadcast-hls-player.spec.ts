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
