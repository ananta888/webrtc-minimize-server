import { signal } from "@angular/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineAudioSessionService } from "./machine-audio-session.service";
import { MachinePcmConsumer } from "./machine-audio-graph";

const now = 1_788_000_000_000, own = "2".repeat(16), human = "1".repeat(16);
function setup() {
  let consume: MachinePcmConsumer = () => {}, allowed = true;
  const close = vi.fn(async () => {}), track = {};
  const session = { joined: signal(true), roomId: () => "room-aaaaaaaaaaaaaaaaaa",
    machineContext: () => ({ tenantId: "tenant", projectId: "project", taskId: "task", runtimeId: "runtime", hubSessionId: "session" }),
    machineLease: signal({ sessionId: "ms_" + "a".repeat(32), generation: 1, expiresAt: now + 60_000 }) };
  const mesh = { ownPeerId: () => own, membershipEpoch: signal(1), machineReceive: { revision: signal(1),
    supports: vi.fn(() => true),
    grants: () => [{ machinePeerId: own, publisherPeerId: human, publicationIds: ["audio"], expiresAt: now + 60_000 }] },
    sendMachineChatReply: vi.fn(() => ({ messageId: "a".repeat(32), queuedPeers: 1 })),
    machineAudioSource: () => { if (!allowed) throw new Error("meet_audio_source_denied"); return { peerId: human, source: "screen-audio", track }; } };
  const graphs = { supported: () => true, connect: vi.fn(async (_track, callback) => { consume = callback; return { close }; }) };
  const service = new MachineAudioSessionService(session as never, mesh as never, graphs as never);
  return { service, session, mesh, graphs, close, deny: () => { allowed = false; }, consume: (start: number, pcm = new ArrayBuffer(3200)) => { consume(start, pcm); return pcm; } };
}
describe("machine audio subscription", () => {
  it.each(["reopen", "close", "current"])("fences delayed finish cleanup failure after %s", async lifecycle => {
    const f = setup(), sub = await f.service.open("audio", 10);
    for (let i = 0; i < 10; i++) { f.consume(i * 1600); f.service.poll(); f.service.ack(i + 1); }
    let rejectClose!: (error: Error) => void;
    f.close.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectClose = reject; }));
    f.service.finish(sub.subscriptionId, 16000);
    if (lifecycle === "reopen") await f.service.open("audio", 10);
    if (lifecycle === "close") f.service.close();
    const before = f.service.status();
    rejectClose(new Error("private decoder detail"));
    await Promise.resolve();
    if (lifecycle === "current") {
      expect(f.service.status()).toEqual({ open: false, completed: false, error: "meet_audio_finish_failed" });
    } else {
      expect(f.service.status()).toEqual(before);
      if (lifecycle === "reopen") {
        f.consume(0); expect(f.service.poll().chunks[0]).toMatchObject({ sequence: 1, startSample: 0 });
        f.service.ack(1);
      }
    }
    f.service.close();
  });
  it("probes early segmentation without capturing, opening or authorizing a source", () => {
    const f = setup(); f.deny();
    expect(f.service.segmentProbe()).toEqual({ schema: "ananta.meet-audio-segment-probe.v1", profile: "sample-boundary-v1", supported: true });
    expect(f.graphs.connect).not.toHaveBeenCalled(); expect(f.service.status().open).toBe(false);
  });
  it("finishes only acknowledged samples, wipes later queued/callback bytes and retains one authorized reply", async () => {
    const f = setup(), sub = await f.service.open("audio", 10);
    for (let i = 0; i < 10; i++) { f.consume(i * 1600); f.service.poll(); f.service.ack(i + 1); }
    const later = new Uint8Array(3200).fill(123); f.consume(16000, later.buffer);
    const result = f.service.finish(sub.subscriptionId, 16000);
    expect(result).toEqual({ schema: "ananta.meet-audio-segment-finished.v1", subscriptionId: sub.subscriptionId, endSample: 16000 });
    expect(f.service.finish(sub.subscriptionId, 16000)).toEqual(result);
    expect(f.close).toHaveBeenCalledOnce(); expect(later.every(byte => byte === 0)).toBe(true);
    const stale = new Uint8Array(3200).fill(77); f.consume(17600, stale.buffer);
    expect(stale.every(byte => byte === 0)).toBe(true);
    expect(f.service.poll()).toMatchObject({ completed: true, acknowledged: 10, chunks: [] });
    f.service.reply(sub.subscriptionId, "Synthetic response");
    expect(() => f.service.finish(sub.subscriptionId, 16000)).toThrow("meet_audio_finish_denied");
    expect(() => f.service.reply(sub.subscriptionId, "Again")).toThrow(); f.service.close();
  });
  it.each(["unknown", "unacked", "short", "unaligned", "oversize", "revoked", "new-session"])("rejects %s early finish without widening authority", async kind => {
    const f = setup(), sub = await f.service.open("audio", 10);
    for (let i = 0; i < 10; i++) { f.consume(i * 1600); f.service.poll(); if (kind !== "unacked") f.service.ack(i + 1); }
    if (kind === "revoked") f.deny();
    if (kind === "new-session") await f.service.open("audio", 10);
    const end = kind === "short" ? 14400 : kind === "unaligned" ? 16001 : kind === "oversize" ? 161600 : 16000;
    expect(() => f.service.finish(kind === "unknown" ? "other" : sub.subscriptionId, end)).toThrow();
    expect(f.mesh.sendMachineChatReply).not.toHaveBeenCalled(); f.service.close();
  });
  it("early finish neither grants chat send rights nor survives source revocation", async () => {
    const f = setup(), sub = await f.service.open("audio", 10);
    for (let i = 0; i < 10; i++) { f.consume(i * 1600); f.service.poll(); f.service.ack(i + 1); }
    f.service.finish(sub.subscriptionId, 16000); f.mesh.machineReceive.supports.mockReturnValue(false);
    expect(() => f.service.reply(sub.subscriptionId, "Denied")).toThrow();
    f.deny(); vi.advanceTimersByTime(100);
    expect(f.service.status().open).toBe(false);
    expect(() => f.service.finish(sub.subscriptionId, 16000)).toThrow();
  });
  it("allows one source-bound reply only after completion and while authority remains current", async () => {
    const f = setup(), sub = await f.service.open("audio", 1);
    expect(() => f.service.reply(sub.subscriptionId, "Answer")).toThrow("meet_audio_reply_denied");
    for (let i = 0; i < 10; i++) f.consume(i * 1600);
    expect(() => f.service.reply("other", "Answer")).toThrow();
    f.service.reply(sub.subscriptionId, "Answer");
    expect(f.mesh.sendMachineChatReply).toHaveBeenCalledWith("Answer", sub.subscriptionId);
    expect(() => f.service.reply(sub.subscriptionId, "Answer")).toThrow();
    f.service.close(); expect(() => f.service.reply(sub.subscriptionId, "Answer")).toThrow();
  });
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it("binds the current lease and source; exports bounded PCM chunks and wipes acknowledged bytes", async () => {
    const f = setup(), result = await f.service.open("audio", 1);
    expect(result).toMatchObject({ sampleRate: 16000, channels: 1, chunkSamples: 1600, binding: { source: "screen_audio", receive_revision: 1 } });
    const pcm = new ArrayBuffer(3200); new Uint8Array(pcm).fill(127); f.consume(0, pcm);
    expect(() => f.service.ack(1)).toThrow("meet_audio_ack_invalid");
    expect(f.service.poll().chunks[0]).toMatchObject({ sequence: 1, startSample: 0 });
    f.service.ack(1); expect(new Uint8Array(pcm).every(byte => byte === 0)).toBe(true);
    expect(f.service.poll().chunks).toEqual([]); f.service.close(); expect(f.close).toHaveBeenCalled();
  });
  it("never opens a graph without rights and stops on mute or revocation within 100ms", async () => {
    const denied = setup(); denied.deny(); await expect(denied.service.open("audio")).rejects.toThrow();
    expect(denied.graphs.connect).not.toHaveBeenCalled();
    const f = setup(); await f.service.open("audio"); const pcm = f.consume(0); new Uint8Array(pcm).fill(9);
    f.deny(); vi.advanceTimersByTime(100);
    expect(f.service.status().open).toBe(false); expect(new Uint8Array(pcm).every(byte => byte === 0)).toBe(true);
    expect(() => f.service.poll()).toThrow();
  });
  it("rejects timeline gaps, queue overflow and membership/lease generations", async () => {
    const f = setup(); await f.service.open("audio"); expect(() => f.consume(1600)).toThrow();
    await f.service.open("audio"); for (let i = 0; i < 10; i++) f.consume(i * 1600);
    expect(() => f.consume(16_000)).toThrow();
    await f.service.open("audio"); f.mesh.membershipEpoch.set(2); expect(() => f.service.poll()).toThrow();
    await f.service.open("audio"); f.session.machineLease.update(v => ({ ...v, generation: 2 }));
    expect(() => f.service.poll()).toThrow();
  });
  it("finishes at the sample budget, retains only bounded drainable chunks, then expires", async () => {
    const f = setup(); await f.service.open("audio", 1);
    for (let i = 0; i < 10; i++) f.consume(i * 1600);
    expect(f.service.poll()).toMatchObject({ completed: true, chunks: expect.any(Array) });
    expect(f.service.poll().chunks).toHaveLength(5); expect(f.close).toHaveBeenCalledOnce();
    f.service.ack(5); expect(f.service.poll().chunks[0].sequence).toBe(6);
    vi.advanceTimersByTime(30_000); expect(f.service.status().open).toBe(false);
  });
  it("fences callbacks from a previous graph after a new source session", async () => {
    const f = setup(); await f.service.open("audio");
    const stale = f.graphs.connect.mock.calls[0][1] as MachinePcmConsumer;
    await f.service.open("audio"); const bytes = new ArrayBuffer(3200); new Uint8Array(bytes).fill(1); stale(0, bytes);
    expect(f.service.poll().chunks).toEqual([]); expect(new Uint8Array(bytes).every(byte => byte === 0)).toBe(true);
    f.service.close();
  });
  it.each(["revoked", "generation", "gap", "overflow"])("wipes the incoming unqueued PCM buffer on %s rejection", async reason => {
    const f = setup(); await f.service.open("audio");
    if (reason === "revoked") f.deny();
    if (reason === "generation") f.session.machineLease.update(v => ({ ...v, generation: 2 }));
    if (reason === "overflow") for (let i = 0; i < 10; i++) f.consume(i * 1600);
    const bytes = new Uint8Array(3200).fill(123);
    expect(() => f.consume(reason === "gap" ? 1600 : reason === "overflow" ? 16000 : 0, bytes.buffer)).toThrow();
    expect(bytes.every(byte => byte === 0)).toBe(true);
    expect(f.service.status().open).toBe(false);
  });
});
