import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineAvatarImageLoader, parseAvatarImage } from "./machine-avatar-image";
import { MachineAvatarArtwork } from "./machine-avatar-artwork";

// Header/chunk structure only: the fake decoder is explicit, not a PNG decode claim.
function input(width = 8, height = 8) {
  const bytes = new Uint8Array(57), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  view.setUint32(16, width); view.setUint32(20, height); bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([73, 68, 65, 84], 37); bytes.set([73, 69, 78, 68], 49);
  return { png: btoa(String.fromCharCode(...bytes)), sha256: "a".repeat(64) };
}
function setup() {
  let now = 1000;
  const bitmap = { width: 8, height: 8, close: vi.fn() };
  const surface = { ready: vi.fn(() => true), frame: vi.fn(), close: vi.fn() };
  const ports = { clock: () => now, digest: vi.fn(async () => "a".repeat(64)),
    decode: vi.fn(async () => bitmap as unknown as ImageBitmap), create: vi.fn((_artwork: MachineAvatarArtwork) => surface) };
  const check = vi.fn(), loader = new MachineAvatarImageLoader(ports);
  return { ports, loader, bitmap, surface, check, setTime: (value: number) => { now = value; } };
}
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
afterEach(() => vi.restoreAllMocks());

describe("closed normalized avatar image", () => {
  it("accepts only the small normalized RGBA/static structure", () => {
    expect(parseAvatarImage(input())).toMatchObject({ width: 8, height: 8, sha256: "a".repeat(64) });
    for (const value of [null, [], {}, { ...input(), url: "https://image" }, { ...input(), label: "Human" },
      { ...input(), png: "data:image/png;base64," + input().png }, { ...input(), sha256: "A".repeat(64) },
      { ...input(), png: "A".repeat(4 * Math.ceil(5 * 1024 * 1024 / 3) + 4) }, input(0), input(1025), input(8, 1025)]) {
      expect(() => parseAvatarImage(value)).toThrow();
    }
  });
  it("rejects animation, metadata, truncation, trailing bytes and non-normalized headers", () => {
    for (const [offset, values] of [[24, [16]], [25, [2]], [28, [1]], [37, [97, 99, 84, 76]],
      [37, [116, 69, 88, 116]], [33, [255, 255, 255, 255]], [49, [73, 68, 65, 84]]] as [number, number[]][]) {
      const value = input(), bytes = Uint8Array.from(atob(value.png), c => c.charCodeAt(0)); bytes.set(values, offset);
      expect(() => parseAvatarImage({ ...value, png: btoa(String.fromCharCode(...bytes)) })).toThrow();
    }
    const value = input(), raw = atob(value.png);
    for (const modified of [raw.slice(0, -1), raw + "\0"]) expect(() => parseAvatarImage({ ...value, png: btoa(modified) })).toThrow();
  });
});

describe("bounded image surface lifecycle", () => {
  it("requires the digest and current authority before decode and surface attachment", async () => {
    const f = setup(), source = f.loader.create(input(), f.check);
    expect(source.ready()).toBe(false); expect(f.ports.create).not.toHaveBeenCalled();
    await settle(); expect(source.ready()).toBe(true); expect(f.check).toHaveBeenCalledTimes(4);
    const artwork = f.ports.create.mock.calls[0][0] as unknown as { draw(ctx: unknown): void; close(): void };
    const drawing = { drawImage: vi.fn() }; artwork.draw(drawing);
    expect(drawing.drawImage).toHaveBeenCalledWith(f.bitmap, 64, 40, 128, 128);
    source.frame(2); expect(f.surface.frame).toHaveBeenCalledWith(2);
    source.close(); source.close(); expect(f.surface.close).toHaveBeenCalledOnce();
    artwork.close(); expect(f.bitmap.close).toHaveBeenCalledOnce();
  });
  it("does not decode corrupt content or fall back to a neutral source", async () => {
    const f = setup(); f.ports.digest.mockResolvedValue("b".repeat(64));
    const source = f.loader.create(input(), f.check); await settle();
    expect(() => source.ready()).toThrow("digest_invalid");
    expect(f.ports.decode).not.toHaveBeenCalled(); expect(f.ports.create).not.toHaveBeenCalled();
  });
  it("revocation after hash or decode releases resources before any publication", async () => {
    for (const phase of [2, 3]) {
      const f = setup(); let checks = 0;
      f.check.mockImplementation(() => { if (++checks === phase) throw new Error("revoked"); });
      const source = f.loader.create(input(), f.check); await settle();
      expect(() => source.ready()).toThrow("revoked"); expect(f.ports.create).not.toHaveBeenCalled();
      expect(f.bitmap.close).toHaveBeenCalledTimes(phase === 3 ? 1 : 0);
    }
  });
  it("bounds unabortable decode to one outstanding call and closes a late bitmap", async () => {
    const f = setup(); let resolve!: (bitmap: ImageBitmap) => void;
    f.ports.decode.mockImplementation(() => new Promise(done => { resolve = done; }));
    const source = f.loader.create(input(), f.check); await settle(); f.setTime(2000);
    expect(() => source.ready()).toThrow("decode_expired");
    expect(() => f.loader.create(input(), f.check)).toThrow("decoder_busy");
    resolve(f.bitmap as unknown as ImageBitmap); await settle();
    expect(f.bitmap.close).toHaveBeenCalledOnce(); expect(f.ports.create).not.toHaveBeenCalled();
    f.ports.decode.mockResolvedValue(f.bitmap as unknown as ImageBitmap);
    const fresh = f.loader.create(input(), f.check); await settle(); expect(fresh.ready()).toBe(true); fresh.close();
  });
  it("close during decode never attaches late, even with the same new authority", async () => {
    const f = setup(); let resolve!: (bitmap: ImageBitmap) => void;
    f.ports.decode.mockImplementation(() => new Promise(done => { resolve = done; }));
    const source = f.loader.create(input(), f.check); await settle(); source.close();
    resolve(f.bitmap as unknown as ImageBitmap); await settle();
    expect(f.bitmap.close).toHaveBeenCalledOnce(); expect(f.ports.create).not.toHaveBeenCalled();
  });
  it("checks actual decoded dimensions, backwards clocks and attachment errors", async () => {
    for (const phase of ["dimensions", "clock", "attachment"]) {
      const f = setup();
      if (phase === "dimensions") f.bitmap.width = 1025;
      if (phase === "clock") f.ports.decode.mockImplementation(async () => { f.setTime(999); return f.bitmap as unknown as ImageBitmap; });
      if (phase === "attachment") f.ports.create.mockImplementation(() => { throw new Error("busy"); });
      const source = f.loader.create(input(), f.check); await settle();
      expect(() => source.ready()).toThrow(); expect(f.bitmap.close).toHaveBeenCalledOnce();
    }
  });
});
