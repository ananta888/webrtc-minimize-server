import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BroadcastViewerWorkflowService } from "./broadcast-viewer-workflow.service";
import { BroadcastDirectoryEntry, BroadcastPlaybackBootstrap } from "./broadcast-directory.service";

const entry: BroadcastDirectoryEntry = { directoryVersion: 1, programId: "prg_aaaaaaaaaaaaaaaa", title: "Test",
  ownerLabel: null, ownerVisibility: "hidden", visibility: "public", availability: "live", viewerCount: 0,
  latencyMode: "ll-hls", captions: false, programEpoch: 1, policyRevision: 1, playback: "public" };
function bootstrap(epoch = 1): BroadcastPlaybackBootstrap {
  return { bootstrapVersion: 1, program: { ...entry, programEpoch: epoch, policyRevision: epoch },
    resourceRef: `res_${String(epoch).repeat(16)}`, playbackGrant: "ephemeral-private-playback-grant", expiresAt: Date.now() + 60_000 };
}
const services: BroadcastViewerWorkflowService[] = [];
function fixture() {
  const directory = { authorize: vi.fn(async () => bootstrap()) };
  let sequence = 0;
  const session = (resource: string) => ({ playbackSessionId: `pbs_${String(sequence).padStart(24, "0")}`,
    manifestUrl: `/broadcast/play/${resource}/index.m3u8`, expiresAt: Date.now() + 60_000 });
  const gateway = { close: vi.fn(async () => {}), open: vi.fn(async (resource: string) => { sequence++; return session(resource); }),
    renew: vi.fn(async (resource: string) => session(resource)) };
  const service = new BroadcastViewerWorkflowService(directory as never, gateway as never);
  services.push(service);
  return { service, directory, gateway };
}

describe("BroadcastViewerWorkflowService", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    for (const service of services.splice(0)) await service.destroy();
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  });

  it("does not open or recover before explicit watch and playback intent", async () => {
    const f = fixture();
    expect(f.directory.authorize).not.toHaveBeenCalled();
    await expect(f.service.open(entry, "remote-signal")).rejects.toThrow("explicit_broadcast_viewer_start_required");
    await f.service.open(entry, "user-action");
    await f.service.interrupted(f.service.manifestUrl());
    expect(f.directory.authorize).toHaveBeenCalledOnce();
    expect(f.service.selected()).toEqual(entry);
    expect(JSON.stringify(f.service.selected())).not.toContain("grant");
  });

  it("renews the same cookie, then installs a freshly authorized newer resource without changing program", async () => {
    const f = fixture();
    await f.service.open(entry, "user-action");
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.gateway.renew).toHaveBeenCalledOnce();
    f.directory.authorize.mockResolvedValue(bootstrap(2));
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.gateway.open).toHaveBeenCalledTimes(2);
    expect(f.gateway.renew).toHaveBeenCalledOnce();
    expect(f.service.selected()).toMatchObject({ programId: entry.programId, programEpoch: 2 });
    expect(f.service.manifestUrl()).toContain(bootstrap(2).resourceRef);
    expect(f.service.reconnecting()).toBe(false);
  });

  it("waits through an unavailable generation and never reloads the old resource", async () => {
    const f = fixture();
    await f.service.open(entry, "user-action");
    f.service.playbackStarted(f.service.manifestUrl());
    f.directory.authorize.mockRejectedValueOnce(new Error("broadcast_not_available")).mockResolvedValueOnce(bootstrap(2));
    const recovery = f.service.interrupted(f.service.manifestUrl());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.service.reconnecting()).toBe(true);
    expect(f.gateway.open).toHaveBeenCalledOnce();
    await f.service.interrupted(f.service.manifestUrl());
    await vi.advanceTimersByTimeAsync(2_000);
    await recovery;
    expect(f.gateway.open).toHaveBeenCalledTimes(2);
    expect(f.service.selected()?.programEpoch).toBe(2);
    expect(f.gateway.open.mock.calls[1][0]).toBe(bootstrap(2).resourceRef);
  });

  it("waits for output readiness without spending replacement sessions on degraded encoders", async () => {
    const f = fixture();
    await f.service.open(entry, "user-action");
    f.service.playbackStarted(f.service.manifestUrl());
    const degraded = { ...bootstrap(), program: { ...entry, availability: "degraded" as const } };
    f.directory.authorize.mockResolvedValueOnce(degraded).mockResolvedValueOnce(degraded).mockResolvedValueOnce(bootstrap());
    const recovery = f.service.interrupted(f.service.manifestUrl());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.service.reconnecting()).toBe(true);
    expect(f.gateway.open).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.gateway.open).toHaveBeenCalledOnce();
    expect(f.service.reconnecting()).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); await recovery;
    expect(f.gateway.open).toHaveBeenCalledTimes(2);
    expect(f.service.selected()).toEqual(entry);
    expect(f.service.reconnecting()).toBe(false);
    expect(f.service.errorCode()).toBe("");
  });

  it("checks degraded scope before waiting and cancels pending recovery on leave", async () => {
    const f = fixture();
    await f.service.open(entry, "user-action"); f.service.playbackStarted(f.service.manifestUrl());
    f.directory.authorize.mockResolvedValueOnce({ ...bootstrap(), program: { ...entry, availability: "degraded", policyRevision: 2 } });
    await f.service.interrupted(f.service.manifestUrl());
    expect(f.service.errorCode()).toBe("broadcast_playback_scope_changed");
    await f.service.open(entry, "user-action"); f.service.playbackStarted(f.service.manifestUrl());
    f.directory.authorize.mockResolvedValue({ ...bootstrap(), program: { ...entry, availability: "degraded" } });
    const recovery = f.service.interrupted(f.service.manifestUrl());
    await vi.advanceTimersByTimeAsync(0);
    const calls = f.directory.authorize.mock.calls.length, opens = f.gateway.open.mock.calls.length;
    await f.service.close(); await recovery; await vi.advanceTimersByTimeAsync(75_000);
    expect(f.directory.authorize).toHaveBeenCalledTimes(calls);
    expect(f.gateway.open).toHaveBeenCalledTimes(opens);
    expect(f.service.selected()).toBeNull();
  });

  it("cancels retry and all renewal timers on Close/Destroy without later authorization", async () => {
    const f = fixture();
    await f.service.open(entry, "user-action");
    f.service.playbackStarted(f.service.manifestUrl());
    f.directory.authorize.mockRejectedValue(new Error("broadcast_not_available"));
    const recovery = f.service.interrupted(f.service.manifestUrl());
    await vi.advanceTimersByTimeAsync(0);
    await f.service.close();
    await recovery;
    const calls = f.directory.authorize.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.directory.authorize).toHaveBeenCalledTimes(calls);
    expect(f.service.selected()).toBeNull();
    expect(f.service.manifestUrl()).toBe("");
    await f.service.destroy();
    await f.service.open(entry, "user-action");
    expect(f.directory.authorize).toHaveBeenCalledTimes(calls);
  });

  for (const invalid of ["program", "visibility", "old-epoch", "same-resource", "same-epoch-policy"]) {
    it(`rejects ${invalid} instead of silently widening a selected watch`, async () => {
      const f = fixture();
      await f.service.open(entry, "user-action");
      f.service.playbackStarted(f.service.manifestUrl());
      const next = bootstrap(2);
      if (invalid === "program") Object.assign(next.program, { programId: "prg_bbbbbbbbbbbbbbbb" });
      if (invalid === "visibility") Object.assign(next.program, { visibility: "private", playback: "grant-required" });
      if (invalid === "old-epoch") Object.assign(next.program, { programEpoch: 0 });
      if (invalid === "same-resource") Object.assign(next, { resourceRef: bootstrap().resourceRef });
      if (invalid === "same-epoch-policy") { Object.assign(next, { resourceRef: bootstrap().resourceRef }); Object.assign(next.program, { programEpoch: 1 }); }
      f.directory.authorize.mockResolvedValue(next);
      await f.service.interrupted(f.service.manifestUrl());
      expect(f.gateway.open).toHaveBeenCalledOnce();
      expect(f.service.selected()).toBeNull();
      expect(f.service.errorCode()).toBe("broadcast_playback_scope_changed");
    });
  }

  it("ignores an old renewal that resolves after another watch was selected", async () => {
    const f = fixture();
    await f.service.open(entry, "user-action");
    let release!: (value: BroadcastPlaybackBootstrap) => void;
    f.directory.authorize.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(50_000);
    await f.service.close();
    const other = { ...entry, programId: "prg_bbbbbbbbbbbbbbbb" };
    f.directory.authorize.mockResolvedValue({ ...bootstrap(3), program: { ...other, programEpoch: 3, policyRevision: 3 } });
    await f.service.open(other, "user-action");
    const before = f.gateway.close.mock.calls.length;
    release(bootstrap(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.service.selected()?.programId).toBe(other.programId);
    expect(f.gateway.close).toHaveBeenCalledTimes(before);
    expect(f.gateway.renew).not.toHaveBeenCalled();
  });

  it("bounds unavailable recovery to six attempts without unapproved session creation", async () => {
    const f = fixture();
    await f.service.open(entry, "user-action");
    f.service.playbackStarted(f.service.manifestUrl());
    f.directory.authorize.mockRejectedValue(new Error("broadcast_not_available"));
    const recovery = f.service.interrupted(f.service.manifestUrl());
    await vi.advanceTimersByTimeAsync(62_000);
    await recovery;
    expect(f.directory.authorize).toHaveBeenCalledTimes(7);
    expect(f.gateway.open).toHaveBeenCalledOnce();
    expect(f.service.selected()).toBeNull();
  });

  it("recovers a transient renewal denial with fresh same-scope authority and a new session", async () => {
    const f = fixture();
    await f.service.open(entry, "user-action");
    f.service.playbackStarted(f.service.manifestUrl());
    const previousSessionId = f.service.playbackSessionId(), previousManifest = f.service.manifestUrl();
    f.directory.authorize.mockRejectedValueOnce(new Error("broadcast_not_available"));
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.directory.authorize).toHaveBeenCalledTimes(3);
    expect(f.gateway.open).toHaveBeenCalledTimes(2);
    expect(f.gateway.renew).not.toHaveBeenCalled();
    expect(f.service.playbackSessionId()).not.toBe(previousSessionId);
    expect(f.service.manifestUrl()).toBe(previousManifest);
    expect(f.service.selected()).toEqual(entry);
    expect(f.service.reconnecting()).toBe(false);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.gateway.renew).toHaveBeenCalledOnce();
  });

  it("rejects offline authority and reused cookies and bounds same-generation recovery", async () => {
    const f = fixture();
    await f.service.open(entry, "user-action"); f.service.playbackStarted(f.service.manifestUrl());
    f.directory.authorize.mockResolvedValueOnce({ ...bootstrap(), program: { ...entry, availability: "offline" } });
    await f.service.interrupted(f.service.manifestUrl());
    expect(f.service.errorCode()).toBe("broadcast_playback_scope_changed");
    await f.service.open(entry, "user-action"); f.service.playbackStarted(f.service.manifestUrl());
    const previous = { playbackSessionId: f.service.playbackSessionId(), manifestUrl: f.service.manifestUrl(), expiresAt: Date.now() + 60_000 };
    f.gateway.open.mockResolvedValueOnce(previous);
    await f.service.interrupted(f.service.manifestUrl());
    expect(f.service.errorCode()).toBe("broadcast_playback_scope_changed");
    expect(f.service.playbackSessionId()).toBe("");
    await f.service.open(entry, "user-action"); f.service.playbackStarted(f.service.manifestUrl());
    for (let index = 0; index < 4; index++) await f.service.interrupted(f.service.manifestUrl());
    expect(f.service.errorCode()).toBe("broadcast_playback_generation_limit");
    expect(f.service.selected()).toBeNull();
  });

  it("never retries rate limits and bounds successive generation switches", async () => {
    const f = fixture();
    await f.service.open(entry, "user-action");
    f.service.playbackStarted(f.service.manifestUrl());
    f.directory.authorize.mockRejectedValueOnce(new Error("broadcast_temporarily_unavailable"));
    await f.service.interrupted(f.service.manifestUrl());
    expect(f.directory.authorize).toHaveBeenCalledTimes(2);
    expect(f.service.errorCode()).toBe("broadcast_temporarily_unavailable");
    await f.service.open(entry, "user-action");
    f.service.playbackStarted(f.service.manifestUrl());
    for (let epoch = 2; epoch <= 5; epoch++) {
      f.directory.authorize.mockResolvedValue(bootstrap(epoch));
      await f.service.interrupted(f.service.manifestUrl());
    }
    expect(f.service.errorCode()).toBe("broadcast_playback_generation_limit");
    expect(f.service.selected()).toBeNull();
  });
});
