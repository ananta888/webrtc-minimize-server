import { describe, expect, it, vi } from "vitest";
import { PublicationSenderPool } from "./publication-sender-pool";

function setup(limit = 4) {
  const transceivers: any[] = [];
  const pc = { connectionState: "connected", getTransceivers: () => transceivers,
    addTrack: vi.fn((track: object) => {
      const sender = { track, setStreams: vi.fn(), replaceTrack: vi.fn(async (next: object) => { sender.track = next; }) };
      transceivers.push({ sender, stopped: false, direction: "sendrecv" }); return sender;
    }), removeTrack: vi.fn((sender: any) => { sender.track = null; transceivers.find(t => t.sender === sender).direction = "recvonly"; }) };
  const track = (kind = "video") => ({ kind, readyState: "live" }) as MediaStreamTrack;
  const configure = vi.fn(), authorized = vi.fn(() => true), stream = {} as MediaStream;
  const pool = new PublicationSenderPool(limit);
  const acquire = (kind = "video") => pool.acquire(pc as never, track(kind), stream, configure, authorized);
  return { pc, pool, track, configure, authorized, stream, transceivers, acquire,
    release: (sender: RTCRtpSender) => pool.release(pc as never, sender) };
}
describe("publication sender slots", () => {
  it("reuses one transceiver over repeated authorized publications with fresh crypto setup and stream metadata", async () => {
    const f = setup(); let first: RTCRtpSender | undefined;
    for (let i = 0; i < 30; i++) {
      const lease = f.acquire(); first ||= lease.sender; expect(lease.sender).toBe(first);
      expect(await lease.ready).toBe(true); expect(f.transceivers[0].direction).toBe("sendrecv"); f.release(lease.sender);
    }
    expect(f.pc.addTrack).toHaveBeenCalledOnce(); expect(f.configure).toHaveBeenCalledTimes(30);
    expect(first!.setStreams).toHaveBeenCalledTimes(29);
  });
  it("never reuses another kind or an active slot and denies excess allocation", async () => {
    const f = setup(2), video = f.acquire(), audio = f.acquire("audio");
    await Promise.all([video.ready, audio.ready]);
    expect(video.sender).not.toBe(audio.sender); expect(() => f.acquire()).toThrow("sender_slot_limit");
    f.release(video.sender); const reused = f.acquire(); expect(reused.sender).toBe(video.sender); await reused.ready;
  });
  it("fences a late replacement across revoke and reopen; pending slots cannot be borrowed", async () => {
    const f = setup(), original = f.acquire(); await original.ready; f.release(original.sender);
    let finish!: () => void;
    vi.mocked(original.sender.replaceTrack).mockImplementationOnce(track => new Promise(resolve => {
      finish = () => { (original.sender as any).track = track; resolve(); };
    }));
    const pending = f.acquire(); f.release(pending.sender);
    const fresh = f.acquire(); expect(fresh.sender).not.toBe(pending.sender);
    await fresh.ready; finish(); expect(await pending.ready).toBe(false);
    expect(pending.sender.track).toBeNull(); expect(fresh.sender.track?.readyState).toBe("live");
  });
  it("rechecks authorization before activating a replaced sender and quarantines failures", async () => {
    const f = setup(), first = f.acquire(); await first.ready; f.release(first.sender);
    const pending = f.acquire(); f.authorized.mockReturnValue(false);
    expect(await pending.ready).toBe(false); expect(pending.sender.track).toBeNull();
    f.authorized.mockReturnValue(true); vi.mocked(first.sender.replaceTrack).mockRejectedValueOnce(new Error("codec_change"));
    const failed = f.acquire(); await expect(failed.ready).rejects.toThrow("codec_change");
    const fresh = f.acquire(); expect(fresh.sender).not.toBe(first.sender); await fresh.ready;
  });
  it("never assigns a track to a reused sender before successful crypto configuration", async () => {
    const f = setup(), first = f.acquire(); await first.ready; f.release(first.sender);
    f.configure.mockImplementation(() => { throw new Error("e2ee_unavailable"); });
    expect(() => f.acquire()).toThrow("e2ee_unavailable"); expect(first.sender.replaceTrack).not.toHaveBeenCalled();
    expect(first.sender.track).toBeNull();
  });
});
