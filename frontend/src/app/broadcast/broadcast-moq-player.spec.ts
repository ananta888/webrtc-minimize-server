import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BroadcastMoqPlayer,
  HlsFallbackPlaybackPort,
  MoqBrowserProbe,
  MoqPlaybackEvent,
  MoqPlaybackPlan,
  MoqPlaybackPort,
  MoqPlaybackSession,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("BroadcastMoqPlayer", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it("does not resurrect HLS when its open resolves after stop", async () => {
    const test = harness();
    const pending = deferred<void>();
    vi.mocked(test.hls.open).mockReturnValue(pending.promise);
    const starting = test.player.start(plan({ mode: "hls-only" }), new AbortController().signal);
    await vi.waitFor(() => expect(test.hls.open).toHaveBeenCalledOnce());
    await test.player.stop();
    pending.resolve();
    await starting;
    expect(test.player.snapshot().lifecycle).toBe("closed");
    expect(test.player.snapshot().activePath).toBe("none");
    await vi.waitFor(() => expect(test.hls.close).toHaveBeenCalledTimes(2));
  });

  it("ignores MoQ metrics after fallback and after stop", async () => {
    const test = harness();
    await test.player.start(plan(), new AbortController().signal);
    test.emit({ kind: "fatal", reason: "network" });
    await vi.waitFor(() => expect(test.player.snapshot().lifecycle).toBe("playing-hls"));
    const metrics = test.player.snapshot().metrics;
    test.emit({ kind: "object-received", bytes: 4096 });
    expect(test.player.snapshot().metrics).toEqual(metrics);
    await test.player.stop();
    test.emit({ kind: "first-frame", captureTimestampMs: NOW });
    expect(test.player.snapshot().metrics.moqJoinMs).toBeNull();
  });

  it("closes the failed MoQ session even when the fallback budget expired", async () => {
    let now = NOW;
    const test = harness({ now: () => now });
    await test.player.start(plan(), new AbortController().signal);
    now += 10_001;
    test.emit({ kind: "fatal", reason: "stall" });
    await vi.waitFor(() => expect(test.session.close).toHaveBeenCalledOnce());
    expect(test.hls.open).not.toHaveBeenCalled();
  });

  it("does not open HLS when MoQ close fails", async () => {
    const test = harness();
    vi.mocked(test.session.close).mockRejectedValue(new Error("private adapter failure"));
    await test.player.start(plan(), new AbortController().signal);
    test.emit({ kind: "fatal", reason: "relay" });
    await vi.waitFor(() => expect(test.player.snapshot().lifecycle).toBe("failed"));
    expect(test.hls.open).not.toHaveBeenCalled();
    expect(test.player.snapshot().reasonCode).toBe("moq_cleanup_unconfirmed");
  });

  it("shares concurrent stop cleanup and immediately fences events", async () => {
    const test = harness();
    const closing = deferred<void>();
    vi.mocked(test.session.close).mockReturnValue(closing.promise);
    await test.player.start(plan(), new AbortController().signal);
    const first = test.player.stop();
    const second = test.player.stop();
    expect(test.player.snapshot().lifecycle).toBe("closed");
    test.emit({ kind: "object-received", bytes: 123 });
    closing.resolve();
    await Promise.all([first, second]);
    expect(test.session.close).toHaveBeenCalledOnce();
    expect(test.hls.close).toHaveBeenCalledOnce();
    expect(test.player.snapshot().metrics.egressBytes).toBe(0);
  });

  it("waits for an aborted pending handshake to settle and close before HLS", async () => {
    const test = harness();
    const pending = deferred<MoqPlaybackSession>();
    let onEvent!: (event: MoqPlaybackEvent) => void;
    vi.mocked(test.moq.open).mockImplementation((request) => {
      onEvent = request.onEvent;
      test.order.push("moq-open");
      return pending.promise;
    });
    const starting = test.player.start(plan(), new AbortController().signal);
    await vi.waitFor(() => expect(test.moq.open).toHaveBeenCalledOnce());
    onEvent({ kind: "fatal", reason: "network" });
    await Promise.resolve();
    expect(test.hls.open).not.toHaveBeenCalled();
    pending.resolve(test.session);
    await starting;
    expect(test.order).toEqual(["moq-open", "moq-close", "hls-open"]);
    expect(test.session.close).toHaveBeenCalledOnce();
    expect(test.player.snapshot().lifecycle).toBe("playing-hls");
  });

  it("handles a synchronous fatal event without resurrecting the opening session", async () => {
    const test = harness();
    vi.mocked(test.moq.open).mockImplementation(async ({ onEvent }) => {
      onEvent({ kind: "fatal", reason: "codec" });
      return test.session;
    });
    await test.player.start(plan(), new AbortController().signal);
    await vi.waitFor(() => expect(test.hls.open).toHaveBeenCalledOnce());
    expect(test.player.snapshot().lifecycle).toBe("playing-hls");
    expect(test.snapshots.some((state) => state.lifecycle === "playing-moq")).toBe(false);
    expect(test.session.close).toHaveBeenCalledOnce();
  });

  it("bounds a nonsettling handshake and never overlaps HLS with unknown cleanup", async () => {
    vi.useFakeTimers();
    const test = harness();
    const pending = deferred<MoqPlaybackSession>();
    vi.mocked(test.moq.open).mockReturnValue(pending.promise);
    const starting = test.player.start(plan(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(6_000);
    await starting;
    expect(test.player.snapshot()).toMatchObject({ lifecycle: "failed", reasonCode: "moq_cleanup_unconfirmed" });
    expect(test.hls.open).not.toHaveBeenCalled();
    pending.resolve(test.session);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.session.close).toHaveBeenCalledOnce();
    expect(test.hls.open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds codec detection and ignores its late success", async () => {
    vi.useFakeTimers();
    const test = harness();
    const pending = deferred<boolean>();
    vi.mocked(test.probe.decodeSupported).mockReturnValue(pending.promise);
    const starting = test.player.start(plan(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5_000);
    await starting;
    expect(test.player.snapshot().activePath).toBe("hls");
    pending.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.moq.open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an unresponsive close and keeps the second transport closed", async () => {
    vi.useFakeTimers();
    const test = harness();
    vi.mocked(test.session.close).mockReturnValue(new Promise(() => undefined));
    await test.player.start(plan(), new AbortController().signal);
    test.emit({ kind: "fatal", reason: "relay" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(test.player.snapshot().reasonCode).toBe("moq_cleanup_unconfirmed");
    expect(test.hls.open).not.toHaveBeenCalled();
    const stopping = test.player.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
    expect(test.player.snapshot().lifecycle).toBe("closed");
    expect(test.session.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds HLS open and re-closes a late result without showing playback", async () => {
    vi.useFakeTimers();
    const test = harness();
    const pending = deferred<void>();
    vi.mocked(test.hls.open).mockReturnValue(pending.promise);
    const starting = test.player.start(plan({ mode: "hls-only" }), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5_000);
    await starting;
    expect(test.player.snapshot().reasonCode).toBe("hls_fallback_timeout");
    expect(vi.mocked(test.hls.open).mock.calls[0][1].aborted).toBe(true);
    expect(test.hls.close).toHaveBeenCalledOnce();
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.hls.close).toHaveBeenCalledTimes(2);
    expect(test.player.snapshot().activePath).toBe("none");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains synchronous exceptions from capability, open and close ports", async () => {
    for (const source of ["probe", "moq", "hls", "close"] as const) {
      const test = harness();
      const throwing = () => { throw new Error("private adapter details"); };
      if (source === "probe") vi.mocked(test.probe.decodeSupported).mockImplementation(throwing);
      if (source === "moq") vi.mocked(test.moq.open).mockImplementation(throwing);
      if (source === "hls") vi.mocked(test.hls.open).mockImplementation(throwing);
      if (source === "close") vi.mocked(test.session.close).mockImplementation(throwing);
      await test.player.start(plan({ mode: source === "hls" ? "hls-only" : "auto" }), new AbortController().signal);
      if (source === "close") {
        test.emit({ kind: "fatal", reason: "network" });
        await vi.waitFor(() => expect(test.player.snapshot().lifecycle).toBe("failed"));
      }
      expect(JSON.stringify(test.snapshots)).not.toContain("private adapter details");
      expect(test.player.snapshot().lifecycle).toBe(["hls", "close"].includes(source) ? "failed" : "playing-hls");
      await test.player.stop();
    }
  });

  it("does not reopen after stop while MoQ cleanup is pending", async () => {
    const test = harness();
    const pending = deferred<void>();
    vi.mocked(test.session.close).mockReturnValue(pending.promise);
    await test.player.start(plan(), new AbortController().signal);
    test.emit({ kind: "fatal", reason: "stall" });
    await vi.waitFor(() => expect(test.session.close).toHaveBeenCalledOnce());
    const stopping = test.player.stop();
    pending.resolve();
    await stopping;
    expect(test.hls.open).not.toHaveBeenCalled();
    expect(test.session.close).toHaveBeenCalledOnce();
    expect(test.player.snapshot().lifecycle).toBe("closed");
  });

  it("ends rebuffer measurement at fallback and ignores late callbacks", async () => {
    let now = NOW;
    const test = harness({ now: () => now });
    await test.player.start(plan(), new AbortController().signal);
    test.emit({ kind: "rebuffer-start" });
    now += 120;
    test.emit({ kind: "fatal", reason: "stall" });
    await vi.waitFor(() => expect(test.player.snapshot().activePath).toBe("hls"));
    now += 900;
    test.emit({ kind: "rebuffer-end" });
    expect(test.player.snapshot().metrics.rebufferMs).toBe(120);
  });

  it("does not enlarge the fallback window when the clock moves backwards", async () => {
    let now = NOW;
    const test = harness({ now: () => now });
    await test.player.start(plan(), new AbortController().signal);
    now -= 1;
    test.emit({ kind: "fatal", reason: "network" });
    await vi.waitFor(() => expect(test.session.close).toHaveBeenCalledOnce());
    expect(test.player.snapshot().reasonCode).toBe("moq_fallback_budget_exhausted");
    expect(test.hls.open).not.toHaveBeenCalled();
  });

  it("rechecks the total fallback deadline after closing MoQ", async () => {
    let now = NOW;
    const test = harness({ now: () => now });
    vi.mocked(test.session.close).mockImplementation(async () => { now += 1_001; });
    await test.player.start(plan(), new AbortController().signal);
    now += 9_000;
    test.emit({ kind: "fatal", reason: "network" });
    await vi.waitFor(() => expect(test.player.snapshot().lifecycle).toBe("failed"));
    expect(test.player.snapshot().reasonCode).toBe("moq_fallback_budget_exhausted");
    expect(test.hls.open).not.toHaveBeenCalled();
  });

  it("requires cleanup even for an invalid QUIC session", async () => {
    const test = harness();
    vi.mocked(test.moq.open).mockResolvedValue({ quicConnected: false, close: test.session.close } as unknown as MoqPlaybackSession);
    await test.player.start(plan(), new AbortController().signal);
    expect(test.session.close).toHaveBeenCalledOnce();
    expect(test.player.snapshot().activePath).toBe("hls");
    const noClose = harness();
    vi.mocked(noClose.moq.open).mockResolvedValue({ quicConnected: true } as MoqPlaybackSession);
    await noClose.player.start(plan(), new AbortController().signal);
    expect(noClose.player.snapshot().reasonCode).toBe("moq_cleanup_unconfirmed");
    expect(noClose.hls.open).not.toHaveBeenCalled();
  });

  it("bounds stop even when HLS cleanup never completes", async () => {
    vi.useFakeTimers();
    const test = harness();
    vi.mocked(test.hls.close).mockReturnValue(new Promise(() => undefined));
    await test.player.start(plan({ mode: "hls-only" }), new AbortController().signal);
    const first = test.player.stop();
    expect(test.player.stop()).toBe(first);
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    expect(test.player.snapshot().lifecycle).toBe("closed");
    expect(test.hls.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a late handshake result once after stop", async () => {
    const test = harness();
    const pending = deferred<MoqPlaybackSession>();
    vi.mocked(test.moq.open).mockReturnValue(pending.promise);
    const starting = test.player.start(plan(), new AbortController().signal);
    await vi.waitFor(() => expect(test.moq.open).toHaveBeenCalledOnce());
    const stopping = test.player.stop();
    pending.resolve(test.session);
    await Promise.all([starting, stopping]);
    expect(test.session.close).toHaveBeenCalledOnce();
    expect(test.hls.open).not.toHaveBeenCalled();
    expect(test.player.snapshot().lifecycle).toBe("closed");
  });

  it("aborts a pending codec probe without opening either playback path", async () => {
    const test = harness();
    const pending = deferred<boolean>();
    vi.mocked(test.probe.decodeSupported).mockReturnValue(pending.promise);
    const starting = test.player.start(plan(), new AbortController().signal);
    await vi.waitFor(() => expect(test.probe.decodeSupported).toHaveBeenCalledOnce());
    await test.player.stop();
    await starting;
    pending.resolve(true);
    await Promise.resolve();
    expect(test.hls.open).not.toHaveBeenCalled();
    expect(test.moq.open).not.toHaveBeenCalled();
  });

  it("does not let a throwing UI observer interrupt transport cleanup", async () => {
    const test = harness();
    const player = new BroadcastMoqPlayer(test.moq, test.hls, test.probe,
      () => { throw new Error("UI failure"); }, () => NOW);
    await player.start(plan(), new AbortController().signal);
    expect(player.snapshot().lifecycle).toBe("playing-moq");
    await player.stop();
    expect(test.session.close).toHaveBeenCalledOnce();
    expect(test.hls.close).toHaveBeenCalledOnce();
    expect(player.snapshot().lifecycle).toBe("closed");
  });

  it("preserves the monotonic total budget even if epoch time stops advancing", async () => {
    vi.useFakeTimers();
    const test = harness();
    await test.player.start(plan(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10_000);
    test.emit({ kind: "fatal", reason: "network" });
    await vi.advanceTimersByTimeAsync(0);
    expect(test.player.snapshot().reasonCode).toBe("moq_fallback_budget_exhausted");
    expect(test.session.close).toHaveBeenCalledOnce();
    expect(test.hls.open).not.toHaveBeenCalled();
  });
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
