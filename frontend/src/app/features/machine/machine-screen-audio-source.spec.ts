import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineScreenAudioSource, ScreenAudioSink } from "./machine-screen-audio-source";

const now = 1_900_000_000_000, pcm = btoa(String.fromCharCode(...new Uint8Array(9600).fill(127)));
function setup() {
  const authority = { sourceId: "screen-audio:hub", sessionId: "ms_test", leaseGeneration: 1,
    membershipEpoch: 2, screenGeneration: 1, expiresAt: now + 60_000 };
  const sink = { write: vi.fn(), close: vi.fn() };
  const ports = { authority: () => authority, create: vi.fn(async (_signal: AbortSignal) => sink as ScreenAudioSink), monotonic: () => Date.now() };
  return { source: new MachineScreenAudioSource(ports), authority, ports, sink };
}
describe("owned screen audio source", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it("requires exact owned source identity and accepts only sequenced fixed-size PCM", async () => {
    const f = setup(); await expect(f.source.open("human-microphone")).rejects.toThrow("meet_screen_audio_denied");
    expect(f.ports.create).not.toHaveBeenCalled();
    const lease = await f.source.open("screen-audio:hub");
    expect(lease).toMatchObject({ sampleRate: 48000, channels: 1, chunkSamples: 4800, expiresAt: now + 30_000 });
    f.source.push(lease.generation, 1, pcm); expect(f.sink.write).toHaveBeenCalledOnce();
    expect(f.sink.write.mock.calls[0][0].every((sample: number) => sample === 0)).toBe(true);
    expect(() => f.source.push(lease.generation, 1, pcm)).toThrow("meet_screen_audio_chunk_invalid");
    expect(f.source.status().open).toBe(false); expect(f.sink.close).toHaveBeenCalledOnce();
  });
  it("closes on screen activation change, permission loss, stall and clock rollback", async () => {
    for (const change of [(f: ReturnType<typeof setup>) => f.authority.screenGeneration++,
      (f: ReturnType<typeof setup>) => f.authority.leaseGeneration++,
      (f: ReturnType<typeof setup>) => { f.ports.authority = () => { throw new Error("denied"); }; },
      () => vi.setSystemTime(now + 1100), () => vi.setSystemTime(now - 1000)]) {
      vi.setSystemTime(now); const f = setup(); await f.source.open("screen-audio:hub"); change(f);
      vi.advanceTimersByTime(100); expect(f.source.status().open).toBe(false); expect(f.sink.close).toHaveBeenCalledOnce();
    }
  });
  it("bounds bytes and queue failure, wipes PCM and preserves newly authorized source on a stale packet", async () => {
    const f = setup(), old = await f.source.open("screen-audio:hub"), current = await f.source.open("screen-audio:hub");
    expect(() => f.source.push(old.generation, 1, pcm)).toThrow("meet_screen_audio_stale");
    expect(f.source.status().open).toBe(true);
    f.sink.write.mockImplementation(() => { throw new Error("queue_full"); });
    expect(() => f.source.push(current.generation, 1, pcm)).toThrow("queue_full");
    expect(f.source.status().open).toBe(false);
    const next = await f.source.open("screen-audio:hub");
    expect(() => f.source.push(next.generation, 1, "a".repeat(12801))).toThrow("meet_screen_audio_chunk_invalid");
  });
  it("fences asynchronous setup and aborts a hung sink after one second", async () => {
    const f = setup(); let resolve!: (sink: ScreenAudioSink) => void;
    f.ports.create.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = expect(f.source.open("screen-audio:hub")).rejects.toThrow("meet_screen_audio_cancelled");
    vi.advanceTimersByTime(1100); expect(f.ports.create.mock.calls[0][0].aborted).toBe(true);
    await f.source.open("screen-audio:hub"); resolve(f.sink); await pending;
    expect(f.source.status().open).toBe(true); f.source.close();
  });
  it("does not turn a forward wall step into a fake PCM stall", async () => {
    const f = setup(); let elapsed = 0; f.ports.monotonic = () => elapsed;
    const source = new MachineScreenAudioSource(f.ports), lease = await source.open("screen-audio:hub");
    source.push(lease.generation, 1, pcm); elapsed = 100; vi.setSystemTime(now + 4000);
    source.push(lease.generation, 2, pcm); expect(source.status().open).toBe(true);
    elapsed = 200; vi.setSystemTime(now + 30_000);
    expect(() => source.push(lease.generation, 3, pcm)).toThrow("meet_screen_audio_authority_changed");
  });
});
