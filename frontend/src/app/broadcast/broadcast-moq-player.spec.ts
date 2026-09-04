import { describe, expect, it, vi } from "vitest";

import {
  BroadcastMoqPlayer,
  HlsFallbackPlaybackPort,
  MoqBrowserProbe,
  MoqPlaybackEvent,
  MoqPlaybackPlan,
  MoqPlaybackPort,
} from "./broadcast-moq-player";

const NOW = 1_800_000_000_000;

function plan(patch: Partial<MoqPlaybackPlan> = {}): MoqPlaybackPlan {
  const base: MoqPlaybackPlan = {
    trigger: "user-action",
    mode: "auto",
    tenantId: "tn_aaaaaaaaaaaaaaaa",
    programId: "prg_bbbbbbbbbbbbbbbb",
    programEpoch: 7,
    audienceId: "aud_cccccccccccccccc",
    namespace: "tn_aaaaaaaaaaaaaaaa/prg_bbbbbbbbbbbbbbbb/epoch/7",
    endpointRef: "moqe_dddddddddddddddd",
    manifestUrl: "https://webrtc.ananta.de/res_eeeeeeeeeeeeeeee/index.m3u8",
    codec: "h264",
    authorized: true,
    negotiation: {
      transport: "moq",
      experimental: true,
      reasonCode: "moq_compatible",
      tenantId: "tn_aaaaaaaaaaaaaaaa",
      programId: "prg_bbbbbbbbbbbbbbbb",
      programEpoch: 7,
      audienceId: "aud_cccccccccccccccc",
      moqtVersion: "draft-ietf-moq-transport-20",
      locVersion: "draft-ietf-moq-loc-04",
      webTransportVersion: "RFC 9297",
      codec: "h264",
    },
  };
  return { ...base, ...patch };
}

function harness(options: { secure?: boolean; webTransport?: boolean; decode?: boolean; now?: () => number } = {}) {
  const order: string[] = [];
  let events: ((event: MoqPlaybackEvent) => void) | null = null;
  const session = { quicConnected: true as const, close: vi.fn(async () => { order.push("moq-close"); }) };
  const moq: MoqPlaybackPort = {
    open: vi.fn(async ({ onEvent }) => {
      order.push("moq-open");
      events = onEvent;
      return session;
    }),
  };
  const hls: HlsFallbackPlaybackPort = {
    open: vi.fn(async () => { order.push("hls-open"); }),
    close: vi.fn(async () => { order.push("hls-close"); }),
  };
  const probe: MoqBrowserProbe = {
    secureContext: options.secure ?? true,
    webTransportAvailable: options.webTransport ?? true,
    decodeSupported: vi.fn(async () => options.decode ?? true),
  };
  const snapshots: ReturnType<BroadcastMoqPlayer["snapshot"]>[] = [];
  const player = new BroadcastMoqPlayer(moq, hls, probe, (state) => snapshots.push(state), options.now ?? (() => NOW));
  return { player, moq, hls, probe, session, snapshots, order, emit: (event: MoqPlaybackEvent) => events?.(event) };
}

describe("BroadcastMoqPlayer", () => {
  it("selects MoQ only after scope, exact pins, secure context, codec and QUIC succeed", async () => {
    const test = harness();
    await test.player.start(plan(), new AbortController().signal);
    expect(test.player.snapshot()).toMatchObject({
      lifecycle: "playing-moq", activePath: "moq", experimental: true, reasonCode: "moq_compatible",
    });
    expect(test.probe.decodeSupported).toHaveBeenCalledWith("h264");
    expect(test.moq.open).toHaveBeenCalledOnce();
    expect(test.hls.open).not.toHaveBeenCalled();
  });

  it("uses one sequential HLS fallback for every bounded MoQ failure class", async () => {
    for (const reason of ["handshake", "auth", "codec", "relay", "network", "stall"] as const) {
      const test = harness();
      await test.player.start(plan(), new AbortController().signal);
      test.emit({ kind: "fatal", reason });
      await vi.waitFor(() => expect(test.player.snapshot().lifecycle).toBe("playing-hls"));
      expect(test.order).toEqual(["moq-open", "moq-close", "hls-open"]);
      expect(test.player.snapshot()).toMatchObject({
        activePath: "hls", reasonCode: `moq_${reason}_failed`,
        metrics: { path: "hls", fallbackCount: 1 },
      });
    }
  });

  it("falls back before opening MoQ when browser capability is absent", async () => {
    for (const options of [{ secure: false }, { webTransport: false }, { decode: false }]) {
      const test = harness(options);
      await test.player.start(plan(), new AbortController().signal);
      expect(test.player.snapshot().activePath).toBe("hls");
      expect(test.moq.open).not.toHaveBeenCalled();
      expect(test.hls.open).toHaveBeenCalledOnce();
    }
  });

  it("does not broaden playback authorization to the fallback", async () => {
    for (const mode of ["auto", "hls-only"] as const) {
      const test = harness();
      await test.player.start(plan({ authorized: false, mode }), new AbortController().signal);
      expect(test.player.snapshot()).toMatchObject({
        lifecycle: "failed", activePath: "none", reasonCode: "playback_authorization_unavailable",
      });
      expect(test.moq.open).not.toHaveBeenCalled();
      expect(test.hls.open).not.toHaveBeenCalled();
    }
  });

  it("keeps MoQ transport metrics separate from HLS and bounded", async () => {
    let now = NOW;
    const test = harness({ now: () => now });
    await test.player.start(plan(), new AbortController().signal);
    now += 120;
    test.emit({ kind: "first-frame", captureTimestampMs: NOW - 80 });
    test.emit({ kind: "object-received", bytes: 64_000 });
    test.emit({ kind: "object-lost", count: 2 });
    test.emit({ kind: "group-dropped", count: 1 });
    test.emit({ kind: "decode-backpressure", count: 3 });
    test.emit({ kind: "rebuffer-start" });
    now += 250;
    test.emit({ kind: "rebuffer-end" });
    expect(test.player.snapshot().metrics).toEqual({
      path: "moq",
      moqJoinMs: 120,
      endToGlassMs: 200,
      rebufferMs: 250,
      objectLoss: 2,
      droppedGroups: 1,
      decodeBackpressure: 3,
      egressBytes: 64_000,
      fallbackCount: 0,
    });
  });

  it("offers explicit HLS diagnosis while auto remains the default", async () => {
    expect(plan().mode).toBe("auto");
    const test = harness();
    await test.player.start(plan({ mode: "hls-only" }), new AbortController().signal);
    expect(test.player.snapshot()).toMatchObject({
      requestedMode: "hls-only", activePath: "hls", reasonCode: "manual_hls_selection",
    });
    expect(test.probe.decodeSupported).not.toHaveBeenCalled();
    expect(test.moq.open).not.toHaveBeenCalled();
  });

  it("fails visibly instead of retrying outside the fallback time budget", async () => {
    let now = NOW;
    const test = harness({ now: () => now });
    await test.player.start(plan(), new AbortController().signal);
    now += 10_001;
    test.emit({ kind: "fatal", reason: "stall" });
    await vi.waitFor(() => expect(test.player.snapshot().lifecycle).toBe("failed"));
    expect(test.player.snapshot().reasonCode).toBe("moq_fallback_budget_exhausted");
    expect(test.hls.open).not.toHaveBeenCalled();
  });

  it("rejects stale scope, wrong drafts and unknown plan fields before either transport", async () => {
    for (const invalid of [
      plan({ namespace: "tn_aaaaaaaaaaaaaaaa/prg_bbbbbbbbbbbbbbbb/epoch/6" }),
      plan({ negotiation: { ...plan().negotiation, moqtVersion: "draft-ietf-moq-transport-19" } }),
      { ...plan(), token: "forbidden" } as MoqPlaybackPlan,
    ]) {
      const test = harness();
      await expect(test.player.start(invalid, new AbortController().signal)).rejects.toThrow();
      expect(test.moq.open).not.toHaveBeenCalled();
      expect(test.hls.open).not.toHaveBeenCalled();
    }
  });

  it("stops MoQ and HLS handles idempotently on abort", async () => {
    const test = harness();
    const controller = new AbortController();
    await test.player.start(plan(), controller.signal);
    controller.abort();
    await vi.waitFor(() => expect(test.player.snapshot().lifecycle).toBe("closed"));
    await test.player.stop();
    expect(test.session.close).toHaveBeenCalledOnce();
    expect(test.hls.close).toHaveBeenCalledOnce();
  });
});
