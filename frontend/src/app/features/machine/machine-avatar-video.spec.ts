import { describe, expect, it, vi } from "vitest";
import { MachineAvatarVideoLoader } from "./machine-avatar-video";
import { parseAvatarVideo, probeAvatarVideo } from "./machine-avatar-video-contract";
import type { AvatarVideoContent } from "./machine-avatar-video-contract";
import type { MachineAvatarArtwork } from "./machine-avatar-artwork";

const value = () => ({ mp4: btoa("0000ftyp00000000"), sha256: "a".repeat(64), frames: 12,
  repeatMode: "loop", originKind: "generated", classification: "test_only" });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function setup() {
  let now = 100, captured: AvatarVideoContent | undefined;
  const pending = deferred(), decoder = { settled: pending.promise, ready: vi.fn(() => true), draw: vi.fn(), close: vi.fn() };
  const surface = { ready: () => true, frame: vi.fn(), close: vi.fn() }, check = vi.fn();
  const ports = { create: vi.fn((_artwork: MachineAvatarArtwork) => surface), decode: vi.fn((content: AvatarVideoContent) => { captured = content; return decoder; }),
    digest: vi.fn(async () => "a".repeat(64)), clock: () => now };
  const loader = new MachineAvatarVideoLoader(ports);
  return { loader, ports, decoder, surface, check, pending, advance: (n: number) => { now += n; }, captured: () => captured };
}

describe("closed bounded video artwork", () => {
  it.each([null, [], {}, { ...value(), url: "https://foreign" }, { ...value(), frames: true }, { ...value(), frames: 121 },
    { ...value(), frames: 1 }, { ...value(), repeatMode: "auto" }, { ...value(), classification: "production" },
    { ...value(), originKind: "camera" }, { ...value(), sha256: "wrong" }, { ...value(), mp4: btoa("invalid padding!") },
    { ...value(), mp4: "a".repeat(2_000_004) }])("rejects malformed/overbroad content before decoding", input => {
    expect(() => parseAvatarVideo(input)).toThrow("meet_avatar_video_invalid");
  });
  it("copies bounded content and probes without a source operation or approval", () => {
    const v = value(), parsed = parseAvatarVideo(v); parsed.bytes.fill(0);
    expect(v.mp4).toBe(value().mp4);
    expect(probeAvatarVideo(() => "probably")).toEqual({ schema: "ananta.meet-avatar-video-probe.v1", profile: "persona-video-v1", mp4H264: true });
    expect(probeAvatarVideo(() => "").mp4H264).toBe(false);
    expect(probeAvatarVideo(() => { throw new Error("unsupported"); }).mp4H264).toBe(false);
  });
  it("authenticates bytes, waits for decoder readiness and paints only current labeled artwork", async () => {
    const f = setup(), source = f.loader.create(value(), f.check); await flush();
    expect(f.ports.create).not.toHaveBeenCalled(); expect(f.captured()!.bytes.every(b => b === 0)).toBe(true);
    f.decoder.ready.mockReturnValue(false); expect(source.ready()).toBe(false);
    f.decoder.ready.mockReturnValue(true); expect(source.ready()).toBe(true);
    const artwork = f.ports.create.mock.calls[0][0] as unknown as { draw(context: unknown): void; close(): void };
    const drawing = { fillText: vi.fn() }; artwork.draw(drawing);
    expect(f.decoder.draw).toHaveBeenCalledWith(drawing); expect(drawing.fillText).toHaveBeenCalledWith("TEST", 128, 183);
    source.frame(1); expect(f.surface.frame).toHaveBeenCalledExactlyOnceWith(1);
    source.close(); source.close(); expect(f.surface.close).toHaveBeenCalledOnce(); expect(f.decoder.close).toHaveBeenCalledOnce();
    expect(() => f.loader.create(value(), f.check)).toThrow("decoder_busy");
    f.pending.resolve(); await flush(); const next = f.loader.create(value(), f.check); next.close(); await flush();
  });
  it("revocation before digest completion never creates a decoder or releases its permit early", async () => {
    const f = setup(), gate = deferred();
    f.ports.digest.mockImplementation(async () => { await gate.promise; return "a".repeat(64); });
    const source = f.loader.create(value(), f.check); source.close();
    for (let i = 0; i < 12; i++) expect(() => f.loader.create(value(), f.check)).toThrow("decoder_busy");
    gate.resolve(); await flush(); expect(f.ports.decode).not.toHaveBeenCalled(); expect(f.ports.create).not.toHaveBeenCalled();
    f.loader.create(value(), f.check).close(); await flush();
  });
  it.each(["digest", "clock", "policy", "decode", "surface"])("fails without fallback after %s failure", async failure => {
    const f = setup();
    if (failure === "digest") f.ports.digest.mockResolvedValue("b".repeat(64));
    if (failure === "decode") f.ports.decode.mockImplementation(() => { throw new Error("decode"); });
    if (failure === "surface") f.ports.create.mockImplementation(() => { throw new Error("surface"); });
    const source = f.loader.create(value(), f.check);
    if (failure === "clock") f.advance(2000);
    if (failure === "policy") f.check.mockImplementation(() => { throw new Error("revoked"); });
    await flush(); expect(() => source.ready()).toThrow();
    expect(f.surface.frame).not.toHaveBeenCalled(); source.close(); f.pending.resolve(); await flush();
  });
  it("holds a stalled native play permit through close and tolerates cleanup failures", async () => {
    const f = setup(), source = f.loader.create(value(), f.check); await flush(); expect(source.ready()).toBe(true);
    f.surface.close.mockImplementation(() => { throw new Error("cleanup"); });
    f.decoder.close.mockImplementation(() => { throw new Error("cleanup"); });
    source.close(); expect(() => f.loader.create(value(), f.check)).toThrow("decoder_busy");
    f.pending.resolve(); await flush(); f.loader.create(value(), f.check).close(); await flush();
  });
  it("checks current authority during each paint and rejects backward clock before decoder start", async () => {
    const f = setup(), source = f.loader.create(value(), f.check); await flush(); source.ready();
    f.check.mockImplementation(() => { throw new Error("revoked"); });
    expect(() => source.frame(2)).toThrow("revoked"); expect(f.surface.frame).not.toHaveBeenCalled(); f.pending.resolve(); await flush();
    const g = setup(), denied = g.loader.create(value(), g.check); g.advance(-1); await flush();
    expect(() => denied.ready()).toThrow(); expect(g.ports.decode).not.toHaveBeenCalled();
  });
});
