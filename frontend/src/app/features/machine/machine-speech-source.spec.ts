import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineSpeechGraph, MachineSpeechSource, speechPcm } from "./machine-speech-source";

const now = 1_788_000_000_000;
const pcm = (samples = 441) => btoa("\u0001\u0000".repeat(samples));
function setup() {
  const authority = { sourceId: "speech:hub", sessionId: "ms_test", leaseGeneration: 1, membershipEpoch: 2, expiresAt: now + 60_000 };
  const graph = { push: vi.fn(), close: vi.fn() };
  let progress!: (played: number) => void;
  let failed!: () => void;
  let signal!: AbortSignal;
  const ports = { authority: () => authority, create: vi.fn(async (_total: number, notify: (played: number) => void,
    error: () => void, abort: AbortSignal): Promise<MachineSpeechGraph> => {
    progress = notify; failed = error; signal = abort; return graph;
  }) };
  return { source: new MachineSpeechSource(ports), authority, graph, ports,
    progress: (played: number) => progress(played), fail: () => failed(), signal: () => signal };
}

describe("bounded synthetic speech source", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("accepts only a bounded complete PCM16LE frame before graph handoff", () => {
    expect(new DataView(speechPcm(pcm())).getInt16(0, true)).toBe(1);
    for (const value of [null, "", "!", pcm(442), btoa("x"), "a".repeat(1177)]) {
      expect(() => speechPcm(value)).toThrow();
    }
  });

  it.each([0, 882001, true, 1.5, "441"])("rejects invalid sample budget %s before creating a source", async total => {
    const f = setup(); await expect(f.source.open("speech:hub", total as never)).rejects.toThrow();
    expect(f.ports.create).not.toHaveBeenCalled();
  });

  it("requires the verified source identity without capture or an inferred stream", async () => {
    const f = setup(); await expect(f.source.open("speech:other", 441)).rejects.toThrow();
    expect(f.ports.create).not.toHaveBeenCalled();
  });

  it("preserves exact sample order and completes only on actual graph progress", async () => {
    const f = setup(), opened = await f.source.open("speech:hub", 450);
    expect(opened).toMatchObject({ sampleRate: 22050, channels: 1, format: "pcm_s16le", queueSamples: 4410 });
    f.source.push(opened.generation, 0, pcm()); f.source.push(opened.generation, 441, pcm(9));
    expect(f.source.status()).toMatchObject({ state: "open", receivedSamples: 450, playedSamples: 0, bufferedSamples: 450 });
    f.progress(441); expect(f.source.status().state).toBe("open");
    f.progress(450); expect(f.source.status()).toMatchObject({ state: "completed", bufferedSamples: 0 });
    expect(f.graph.close).toHaveBeenCalledOnce(); expect(f.signal().aborted).toBe(true);
  });

  it("bounds both total output and the pending queue", async () => {
    const f = setup(), opened = await f.source.open("speech:hub", 22050);
    for (let i = 0; i < 10; i++) f.source.push(opened.generation, 441 * i, pcm());
    expect(() => f.source.push(opened.generation, 4410, pcm())).toThrow("meet_speech_buffer_exceeded");
    expect(f.source.status().bufferedSamples).toBe(0); expect(f.graph.close).toHaveBeenCalledOnce();
    const g = setup(), short = await g.source.open("speech:hub", 440);
    expect(() => g.source.push(short.generation, 0, pcm())).toThrow(); expect(g.graph.push).not.toHaveBeenCalled();
  });

  it.each(["order", "format", "progress", "graph"])("closes malformed %s without retaining pending audio", async failure => {
    const f = setup(), opened = await f.source.open("speech:hub", 22050);
    if (failure === "order") expect(() => f.source.push(opened.generation, 1, pcm())).toThrow();
    else if (failure === "format") expect(() => f.source.push(opened.generation, 0, "invalid!")).toThrow();
    else if (failure === "progress") f.progress(1);
    else f.fail();
    expect(f.source.status()).toMatchObject({ state: "failed", bufferedSamples: 0 });
    expect(f.graph.close).toHaveBeenCalledOnce();
  });

  it.each(["lease", "membership", "expiry", "clock", "stall"])("revokes on %s without a caller polling", async change => {
    const f = setup(); await f.source.open("speech:hub", 22050);
    if (change === "lease") f.authority.leaseGeneration++;
    else if (change === "membership") f.authority.membershipEpoch++;
    else if (change === "expiry") f.authority.expiresAt = now;
    else vi.setSystemTime(change === "clock" ? now - 1000 : now + 2000);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.source.status().state).toBe("failed"); expect(f.graph.close).toHaveBeenCalledOnce();
  });

  it("late setup results and callbacks cannot overwrite or stop a replacement generation", async () => {
    const f = setup(); let resolve!: (graph: MachineSpeechGraph) => void;
    f.ports.create.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const rejected = expect(f.source.open("speech:hub", 441)).rejects.toThrow();
    f.source.close(); const current = await f.source.open("speech:hub", 441);
    const stale = { push: vi.fn(), close: vi.fn() }; resolve(stale); await rejected;
    expect(stale.close).toHaveBeenCalledOnce(); expect(f.graph.close).not.toHaveBeenCalled();
    expect(() => f.source.push(current.generation - 2, 0, pcm())).toThrow("meet_speech_frame_stale");
    expect(f.source.status().state).toBe("open"); f.source.close();
  });

  it("closes a graph when authority changes after setup resolves", async () => {
    const f = setup(); f.ports.create.mockImplementationOnce(async () => { f.authority.membershipEpoch++; return f.graph; });
    await expect(f.source.open("speech:hub", 441)).rejects.toThrow();
    expect(f.graph.close).toHaveBeenCalledOnce(); expect(f.source.status().state).toBe("failed");
  });

  it("expires hung setup and closes its eventual late graph", async () => {
    const f = setup(); let resolve!: (graph: MachineSpeechGraph) => void;
    f.ports.create.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = expect(f.source.open("speech:hub", 441)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10000); await pending;
    resolve(f.graph); await Promise.resolve(); expect(f.graph.close).toHaveBeenCalledOnce();
    expect(f.source.status().state).toBe("failed");
  });
});
