import { afterEach, describe, expect, it, vi } from "vitest";
import { BroadcastSourceRequestsService, parseSourceInvitations } from "./broadcast-source-requests.service";

const owner = "0123456789abcdef", target = "fedcba9876543210", room = "room-alpha", programId = "prg_aaaaaaaaaaaaaaaa";
const program = { programId, programRevision: 3, programEpoch: 2 };
function invitation(overrides = {}) { return { requestId: "bsr_" + "a".repeat(24), roomId: room, programId,
  programRevision: 5, programEpoch: 2, ownerPeerId: owner, targetPeerId: target, packagerRef: "pkr_aaaaaaaaaaaaaaaa",
  sourceKind: "camera", state: "pending", createdAt: Date.now(), expiresAt: Date.now() + 120000, authority: "none", ...overrides }; }
const reply = (items = [invitation()]) => Response.json({ responseVersion: 1, requests: items });
const control = () => Response.json({ controlVersion: 1, programId, programRevision: 5, programEpoch: 2,
  state: "live", handoffPending: false, writer: { packagerId: "pkr_aaaaaaaaaaaaaaaa", fencingRevision: 3 } });
function fixture(peerId = owner) {
  let fingerprint = "a".repeat(43), token = "synthetic-test-token";
  const fetch = vi.fn(async () => reply()); vi.stubGlobal("fetch", fetch);
  const service = new BroadcastSourceRequestsService({ authorizationHeader: () => ({ Authorization: `Bearer ${token}` }) } as never,
    { fingerprint: () => fingerprint } as never);
  service.setScope(room, peerId);
  return { service, fetch, changeDevice: () => { fingerprint = "b".repeat(43); }, changeAuth: () => { token = "changed"; } };
}
describe("source invitation metadata port", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it("does not fetch on scope changes; create reads current writer revision once before the mutation", async () => {
    const f = fixture(); expect(f.fetch).not.toHaveBeenCalled();
    f.fetch.mockResolvedValueOnce(control()).mockResolvedValueOnce(reply());
    await f.service.create(program, target, "camera");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    const [url, init] = (f.fetch.mock.calls as unknown as [string, RequestInit][])[1];
    expect(url).toBe("/api/broadcast-source-requests");
    expect(JSON.parse(String(init.body))).toEqual({ requestVersion: 1, action: "create", roomId: room,
      deviceFingerprint: "a".repeat(43), trigger: "user-action", programId, expectedProgramRevision: 5,
      expectedProgramEpoch: 2, targetPeerId: target, sourceKind: "camera" });
    expect(f.service.items()[0].authority).toBe("none");
  });
  it("rejects malformed, cross-room, cross-peer, duplicated, overlong and authorizing responses", () => {
    const valid = invitation();
    for (const bad of [{ ...valid, authority: "decrypt" }, { ...valid, roomId: "room-other" },
      { ...valid, ownerPeerId: target, targetPeerId: "aaaaaaaaaaaaaaaa" }, { ...valid, ownerPeerId: [owner] },
      { ...valid, expiresAt: valid.expiresAt + 1 }, { ...valid, secret: "forbidden" }]) {
      expect(() => parseSourceInvitations({ responseVersion: 1, requests: [bad] }, room, owner)).toThrow();
    }
    expect(() => parseSourceInvitations({ responseVersion: 1, requests: [valid, valid] }, room, owner)).toThrow();
  });
  for (const change of ["room", "peer", "reset", "device", "auth"]) {
    it(`ignores late results after ${change} changes`, async () => {
      const f = fixture(); let resolve!: (value: Response) => void;
      f.fetch.mockImplementation(() => new Promise(done => { resolve = done; }));
      const pending = f.service.load();
      if (change === "room") f.service.setScope("room-other", owner);
      if (change === "peer") f.service.setScope(room, target);
      if (change === "reset") f.service.reset();
      if (change === "device") f.changeDevice();
      if (change === "auth") f.changeAuth();
      resolve(reply()); await pending;
      expect(f.service.items()).toEqual([]); expect(f.service.loaded()).toBe(false);
    });
  }
  it("does not send a mutation if identity changes during the control read", async () => {
    const f = fixture(); f.fetch.mockImplementation(async () => { f.changeAuth(); return control(); });
    await f.service.create(program, target, "camera");
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.service.items()).toEqual([]);
  });
  it("cancel/decline require a current item and preserve all immutable response fields", async () => {
    const f = fixture(target); await f.service.load(); const item = f.service.items()[0];
    f.fetch.mockResolvedValue(reply([{ ...item, state: "declined" }])); await f.service.finish(item);
    expect(JSON.parse(String((f.fetch.mock.calls as unknown as [string, RequestInit][])[1][1].body)).action).toBe("decline");
    expect(f.service.items()[0].state).toBe("declined");
    await f.service.finish(item); expect(f.fetch).toHaveBeenCalledTimes(2);
    const g = fixture(); await g.service.load(); const original = g.service.items()[0];
    g.fetch.mockResolvedValue(reply([{ ...original, state: "cancelled", programEpoch: 99 }]));
    await g.service.finish(original); expect(g.service.items()).toEqual([]); expect(g.service.error()).not.toBe("");
  });
  it("bounds response bytes and deadlines and never retries a failed operation", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response("x".repeat(65537), { headers: { "content-type": "application/json" } }));
    await f.service.load(); expect(f.service.items()).toEqual([]); expect(f.fetch).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    f.fetch.mockImplementation((_url?: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = f.service.load(); await vi.advanceTimersByTimeAsync(15000); await pending;
    expect(f.service.busy()).toBe(false); expect(f.fetch).toHaveBeenCalledTimes(2);
  });
});
