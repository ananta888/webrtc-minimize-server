import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineMediaHandle, MachineMediaPublication } from "./machine-media-publication";

const encoded = btoa("\0\0\0\x08ftyp"); // Decoder is a fake port here, not media evidence.
function setup() {
  const authority = { sessionId: "ms_test", generation: 1, expiresAt: Date.now() + 100_000, avatar: true, speech: true };
  const handle: MachineMediaHandle = { ready: vi.fn(() => true), metadata: () => ({ duration: 1, width: 640, height: 360 }),
    attach: vi.fn(), play: vi.fn(async () => {}), ended: vi.fn(() => true), failed: vi.fn(() => false), close: vi.fn() };
  const ports = { authority: () => authority, create: vi.fn(() => handle), transportReady: vi.fn(() => true), monotonic: () => Date.now() };
  return { publication: new MachineMediaPublication(ports), handle, authority, ports };
}
describe("synthetic machine publication lifecycle", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_900_000_000_000); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it("publishes only selected outputs and wipes bytes after release", async () => {
    const f = setup(), pending = f.publication.publish(encoded, ["speech"]);
    await vi.advanceTimersByTimeAsync(50); await pending;
    expect(f.handle.attach).toHaveBeenCalledWith(["speech"]); expect(f.handle.close).toHaveBeenCalledOnce();
    expect(f.ports.create.mock.calls[0][0].every((b: number) => b === 0)).toBe(true);
    expect(f.publication.status().active).toBe(false);
  });
  it("allows a bounded audio-only MP4 for speech, but never as an avatar source", async () => {
    const f = setup(); f.handle.metadata = () => ({ duration: 1, width: 0, height: 0 });
    const pending = f.publication.publish(encoded, ["speech"]); await vi.advanceTimersByTimeAsync(50); await pending;
    await expect(f.publication.publish(encoded, ["avatar"])).rejects.toThrow("machine_media_metadata_invalid");
  });
  it("does not spend a relative loading budget on a forward wall-clock step", async () => {
    const f = setup(); let elapsed = 0; f.ports.monotonic = () => elapsed;
    const publication = new MachineMediaPublication(f.ports);
    vi.mocked(f.handle.ready).mockReturnValue(false);
    const pending = publication.publish(encoded, ["speech"]);
    vi.setSystemTime(Date.now() + 30_000); elapsed = 100; vi.mocked(f.handle.ready).mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(100); await pending;
    expect(f.handle.close).toHaveBeenCalledOnce();
  });
  it("rejects malformed, oversized or unauthorized sources before decoder allocation", async () => {
    const f = setup(); f.authority.speech = false;
    await expect(f.publication.publish(encoded, ["speech"])).rejects.toThrow("machine_media_denied");
    for (const [data, outputs] of [["!", ["avatar"]], ["a".repeat(4_700_001), ["avatar"]], [encoded, []],
      [encoded, ["avatar", "avatar"]], [encoded, ["screen"]]]) {
      await expect(f.publication.publish(data, outputs as never)).rejects.toThrow("machine_media_request_invalid");
    }
    expect(f.ports.create).not.toHaveBeenCalled();
  });
  it("a cancelled old publisher cannot stop a newly opened publisher", async () => {
    const f = setup(); vi.mocked(f.handle.ready).mockReturnValue(false);
    const old = expect(f.publication.publish(encoded, ["avatar"])).rejects.toThrow("machine_media_cancelled");
    f.publication.close();
    const current = expect(f.publication.publish(encoded, ["speech"])).rejects.toThrow("machine_media_cancelled");
    await old; expect(f.publication.status()).toEqual({ active: true, outputs: ["speech"] });
    expect(f.handle.close).toHaveBeenCalledOnce(); f.publication.close(); await current;
    expect(f.handle.close).toHaveBeenCalledTimes(2);
  });
  it("fences renewal, expiry, permission loss and clock rollback during playback", async () => {
    for (const change of [(f: ReturnType<typeof setup>) => f.authority.generation++,
      (f: ReturnType<typeof setup>) => f.authority.expiresAt = Date.now(),
      (f: ReturnType<typeof setup>) => f.authority.avatar = false,
      () => vi.setSystemTime(Date.now() - 1000)]) {
      const f = setup(); vi.mocked(f.handle.ended).mockReturnValue(false);
      const pending = expect(f.publication.publish(encoded, ["avatar"])).rejects.toThrow("machine_media_authority_changed");
      await vi.advanceTimersByTimeAsync(50); change(f); await vi.advanceTimersByTimeAsync(50); await pending;
      expect(f.handle.close).toHaveBeenCalledOnce();
    }
  });
  it("rejects concurrent writers, decode errors and oversized dimensions", async () => {
    const f = setup(); vi.mocked(f.handle.ready).mockReturnValue(false);
    const pending = expect(f.publication.publish(encoded, ["avatar"])).rejects.toThrow("machine_media_decode_failed");
    await expect(f.publication.publish(encoded, ["speech"])).rejects.toThrow("machine_media_busy");
    vi.mocked(f.handle.failed).mockReturnValue(true); await vi.advanceTimersByTimeAsync(50); await pending;
    const g = setup(); g.handle.metadata = () => ({ duration: 1, width: 8000, height: 8000 });
    await expect(g.publication.publish(encoded, ["avatar"])).rejects.toThrow("machine_media_metadata_invalid");
    expect(g.handle.attach).not.toHaveBeenCalled(); expect(g.handle.close).toHaveBeenCalledOnce();
  });
  it("bounds a stalled play promise and never sends before the transport ACK", async () => {
    const f = setup(), onReady = vi.fn(); f.ports.transportReady.mockReturnValue(false);
    const pending = expect(f.publication.publish(encoded, ["avatar"], onReady)).rejects.toThrow("machine_media_timeout");
    await vi.advanceTimersByTimeAsync(20_100); await pending; expect(onReady).not.toHaveBeenCalled();
    const g = setup(); vi.mocked(g.handle.play).mockImplementation(() => new Promise(() => {}));
    const stalled = expect(g.publication.publish(encoded, ["avatar"])).rejects.toThrow("machine_media_timeout");
    await vi.advanceTimersByTimeAsync(45_100); await stalled; expect(g.handle.close).toHaveBeenCalledOnce();
  });
});
