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
    // The next clip waits for the previous native play to settle; never two decoders.
    const next = f.loader.create(value(), f.check); await flush();
    expect(f.ports.decode).toHaveBeenCalledOnce(); expect(next.ready()).toBe(false);
    f.pending.resolve(); await flush(); expect(f.ports.decode).toHaveBeenCalledTimes(2); expect(next.ready()).toBe(true);
    next.close(); await flush();
  });
  it("revocation before digest completion never creates a decoder or releases its permit early", async () => {
    const f = setup(), gate = deferred();
    f.ports.digest.mockImplementation(async () => { await gate.promise; return "a".repeat(64); });
    const source = f.loader.create(value(), f.check); source.close();
    const waiting = f.loader.create(value(), f.check); await flush();
    expect(f.ports.decode).not.toHaveBeenCalled(); expect(f.ports.create).not.toHaveBeenCalled();
    gate.resolve(); await flush(); expect(f.ports.decode).toHaveBeenCalledOnce(); // Only the successor decodes.
    expect(waiting.ready()).toBe(true); waiting.close(); await flush();
  });
  it("keeps the previous camera held from open until the clip surface exists or the clip closes", async () => {
    const f = setup(), release = vi.fn(), hold = vi.fn(() => release);
    const loader = new MachineAvatarVideoLoader({ ...f.ports, hold });
    const source = loader.create(value(), f.check); expect(hold).toHaveBeenCalledOnce(); expect(release).not.toHaveBeenCalled();
    await flush(); expect(release).not.toHaveBeenCalled();
    expect(source.ready()).toBe(true); expect(release).toHaveBeenCalledOnce();
    source.close(); expect(release).toHaveBeenCalledOnce(); f.pending.resolve(); await flush();
    f.ports.digest.mockResolvedValue("b".repeat(64));
    const failing = loader.create(value(), f.check); await flush();
    expect(() => failing.ready()).toThrow(); expect(release).toHaveBeenCalledTimes(2);
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
    source.close(); const next = f.loader.create(value(), f.check); await flush();
    expect(f.ports.decode).toHaveBeenCalledOnce(); f.advance(2000);
    expect(() => next.ready()).toThrow("decode_expired"); // A stalled predecessor is bounded by the decode deadline.
    f.pending.resolve(); await flush(); expect(f.ports.decode).toHaveBeenCalledOnce();
    f.loader.create(value(), f.check).close(); await flush();
  });
  it("reports not-ready while attaching under a fenced scope instead of throwing", async () => {
    const f = setup(), source = f.loader.create(value(), f.check); await flush();
    // The owning source is still opening: its guard decides whether the
    // generation ends, so a revoked scope must not attach or throw here.
    f.check.mockImplementation(() => { throw new Error("revoked"); });
    expect(source.ready()).toBe(false); expect(f.ports.create).not.toHaveBeenCalled();
    f.check.mockImplementation(() => undefined);
    expect(source.ready()).toBe(true); expect(f.ports.create).toHaveBeenCalledOnce();
    // A real decode failure still propagates rather than reporting not-ready.
    f.decoder.ready.mockImplementation(() => { throw new Error("meet_avatar_video_decoder_failed"); });
    expect(() => source.ready()).toThrow("decoder_failed");
    f.pending.resolve(); await flush();
  });
  it("checks current authority during each paint and rejects backward clock before decoder start", async () => {
    const f = setup(), source = f.loader.create(value(), f.check); await flush(); source.ready();
    f.check.mockImplementation(() => { throw new Error("revoked"); });
    expect(() => source.frame(2)).toThrow("revoked"); expect(f.surface.frame).not.toHaveBeenCalled(); f.pending.resolve(); await flush();
    const g = setup(), denied = g.loader.create(value(), g.check); g.advance(-1); await flush();
    expect(() => denied.ready()).toThrow(); expect(g.ports.decode).not.toHaveBeenCalled();
  });
});
