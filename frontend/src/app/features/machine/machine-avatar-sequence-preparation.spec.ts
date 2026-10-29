import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAvatarSequence } from "./machine-avatar-sequence-contract";
import { AvatarSequencePreparation, AVATAR_SEQUENCE_PREPARATION_MS } from "./machine-avatar-sequence-preparation";
import { SPEECH_RATE } from "./machine-speech-format";

const content = () => parseAvatarSequence({ schema: "ananta.meet-avatar-sequence.v1", totalSamples: SPEECH_RATE / 6,
  clips: [{ startSample: 0, endSample: SPEECH_RATE / 6, content: { mp4: btoa("0000ftyp00000000"),
    sha256: "a".repeat(64), frames: 2, repeatMode: "hold_last", originKind: "generated", classification: "test_only" } }] });
function fixture() {
  const owned = [{ draw: vi.fn(), close: vi.fn() }, { draw: vi.fn(), close: vi.fn() }];
  const decoder = { frame: vi.fn(async (index: number) => owned[index]), close: vi.fn() };
  const ports = { digest: vi.fn(async () => "a".repeat(64)), decode: vi.fn(async () => decoder), clock: () => 0 };
  return { owned, decoder, ports, prepare: new AvatarSequencePreparation(ports), caller: new AbortController() };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("single owned atlas and bounded decoder preparation", () => {
  it("keeps the atlas permit until close, erases encoded bytes and releases each resource once", async () => {
    const f = fixture(), data = content();
    const prepared = await f.prepare.prepare(data, () => {}, f.caller.signal);
    expect(data.clips[0].content.bytes.every(v => v === 0)).toBe(true);
    expect(f.decoder.close).toHaveBeenCalledOnce();
    await expect(f.prepare.prepare(content(), () => {}, f.caller.signal)).rejects.toThrow("preparation_busy");
    prepared.draw(0, 1, {} as CanvasRenderingContext2D);
    expect(f.owned[1].draw).toHaveBeenCalledOnce();
    prepared.close(); prepared.close();
    for (const frame of f.owned) expect(frame.close).toHaveBeenCalledOnce();
    expect(() => prepared.draw(0, 0, {} as CanvasRenderingContext2D)).toThrow("frame_invalid");
  });
  it("verifies content digest before any decoder exists", async () => {
    const f = fixture(); f.ports.digest.mockResolvedValue("b".repeat(64));
    await expect(f.prepare.prepare(content(), () => {}, f.caller.signal)).rejects.toThrow("digest_invalid");
    expect(f.ports.decode).not.toHaveBeenCalled();
  });
  it("cleans acquired frames and decoder when current source validation fails", async () => {
    const f = fixture();
    const check = () => { if (f.decoder.frame.mock.calls.length === 1) throw new Error("test_source_retired"); };
    await expect(f.prepare.prepare(content(), check, f.caller.signal)).rejects.toThrow("test_source_retired");
    expect(f.owned[0].close).toHaveBeenCalledOnce(); expect(f.owned[1].close).not.toHaveBeenCalled();
    expect(f.decoder.close).toHaveBeenCalledOnce();
  });
  it("closes a decoder which resolves after cancellation without waiting for it", async () => {
    const f = fixture(); let resolve!: (value: typeof f.decoder) => void;
    f.ports.decode.mockImplementation(() => new Promise(r => { resolve = r; }));
    const pending = f.prepare.prepare(content(), () => {}, f.caller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await flush(); f.caller.abort(); await rejected;
    await expect(f.prepare.prepare(content(), () => {}, new AbortController().signal)).rejects.toThrow("preparation_busy");
    resolve(f.decoder); await flush(); expect(f.decoder.close).toHaveBeenCalledOnce();
  });
  it("bounds hung frame extraction and closes its late bitmap", async () => {
    vi.useFakeTimers(); const f = fixture(); let resolve!: (value: typeof f.owned[0]) => void;
    f.decoder.frame.mockImplementation(() => new Promise(r => { resolve = r; }));
    const pending = f.prepare.prepare(content(), () => {}, f.caller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await flush(); await vi.advanceTimersByTimeAsync(AVATAR_SEQUENCE_PREPARATION_MS); await rejected;
    expect(f.decoder.close).toHaveBeenCalledOnce();
    await expect(f.prepare.prepare(content(), () => {}, new AbortController().signal)).rejects.toThrow("preparation_busy");
    resolve(f.owned[0]); await flush(); expect(f.owned[0].close).toHaveBeenCalledOnce();
  });
  it("never allocates on an already cancelled call", async () => {
    const f = fixture(); f.caller.abort();
    await expect(f.prepare.prepare(content(), () => {}, f.caller.signal)).rejects.toThrow();
    expect(f.ports.digest).not.toHaveBeenCalled(); expect(f.ports.decode).not.toHaveBeenCalled();
  });
  it("does not let an invalid initial clock disable the preparation deadline", async () => {
    const f = fixture(); f.ports.clock = () => NaN;
    await expect(f.prepare.prepare(content(), () => {}, f.caller.signal)).rejects.toThrow("preparation_expired");
    expect(f.ports.digest).not.toHaveBeenCalled();
  });
  it("releases the prepared atlas when its owner cancels after preparation", async () => {
    const f = fixture();
    const prepared = await f.prepare.prepare(content(), () => {}, f.caller.signal);
    f.caller.abort();
    for (const frame of f.owned) expect(frame.close).toHaveBeenCalledOnce();
    expect(() => prepared.draw(0, 0, {} as CanvasRenderingContext2D)).toThrow("frame_invalid");
    prepared.close();
    for (const frame of f.owned) expect(frame.close).toHaveBeenCalledOnce();
  });
  it("continues cleanup after a bitmap close failure and releases the atlas permit", async () => {
    const f = fixture();
    const prepared = await f.prepare.prepare(content(), () => {}, f.caller.signal);
    f.owned[0].close.mockImplementation(() => { throw new Error("test_cleanup_failure"); });
    prepared.close(); expect(f.owned[1].close).toHaveBeenCalledOnce();
    f.owned[0].close.mockReset();
    const next = await f.prepare.prepare(content(), () => {}, f.caller.signal); next.close();
  });
});
