import { describe, expect, it, vi } from "vitest";
import { SourceModerationController, SourceModerationContext, SourceModerationView } from "./source-moderation-controller";
import { parseSourceModerationState } from "./source-moderation-contract";

const NOW = 1800000000000;
const source = { consentId: "cns_" + "a".repeat(16), sourceId: "src_" + "a".repeat(16), sourceKind: "camera",
  publisherPeerId: "b".repeat(16), expiresAt: NOW + 10000 };
function fixture() {
  let time = 0, wall = NOW, sequence = 0;
  let context: SourceModerationContext | null = { key: "session", programId: "prg_" + "a".repeat(16), programEpoch: 1 };
  let view: SourceModerationView = { phase: "idle", state: null };
  const sent: any[] = [];
  const send = vi.fn((message: object) => { sent.push(message); });
  const controller = new SourceModerationController({ context: () => context, send, changed: value => { view = value; },
    monotonic: () => time, wall: () => wall, nonce: () => String(++sequence).padStart(24, "0") });
  const state = () => ({ ...sent.at(-1), type: "broadcast-source-moderation-state", programRevision: 4,
    fencingRevision: 2, observedAt: NOW, expiresAt: NOW + 5000, sources: [{ ...source }] });
  return { controller, sent, send, state, view: () => view, time: (n: number) => { time = n; },
    wall: (n: number) => { wall = n; }, context: (c: SourceModerationContext | null) => { context = c; } };
}
describe("source moderation", () => {
  it("is click-only, checks metadata and only sends removal of a displayed consent", () => {
    const f = fixture(); f.controller.tick(); expect(f.sent).toEqual([]);
    f.controller.query(); f.controller.query(); expect(f.sent).toHaveLength(1);
    f.controller.receive(f.state()); const snapshot = f.view().state;
    expect(f.view().phase).toBe("ready");
    f.controller.revoke("cns_" + "z".repeat(16), snapshot); expect(f.sent).toHaveLength(1);
    f.controller.revoke(source.consentId, snapshot); expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toMatchObject({ type: "broadcast-source-moderation-revoke", consentId: source.consentId,
      programRevision: 4, fencingRevision: 2 });
    f.controller.receive({ version: 1, type: "broadcast-source-moderation-revoked", requestId: f.sent[1].requestId,
      programId: f.sent[1].programId, programEpoch: 1, consentId: source.consentId });
    expect(f.view()).toEqual({ phase: "revoked", state: null }); expect(f.sent).toHaveLength(2);
  });
  it("does not refresh the five second request budget when a delayed answer arrives", () => {
    const f = fixture(); f.controller.query(); f.time(4999); f.controller.receive(f.state());
    expect(f.view().phase).toBe("ready"); const old = f.view().state;
    f.time(5000); f.controller.revoke(source.consentId, old);
    expect(f.sent).toHaveLength(1); expect(f.view().phase).toBe("stale");
  });
  it.each(["timeout", "leave", "identity", "epoch", "clock", "expired", "future", "destroy"])("discards %s observations without touching media", reason => {
    const f = fixture(); f.controller.query(); const response = f.state();
    if (reason === "timeout") f.time(5000);
    if (reason === "leave") f.context(null);
    if (reason === "identity") f.context({ key: "other", programId: response.programId, programEpoch: 1 });
    if (reason === "epoch") f.context({ key: "session", programId: response.programId, programEpoch: 2 });
    if (reason === "clock") f.time(-1);
    if (reason === "expired") f.wall(NOW + 5000);
    if (reason === "future") f.wall(NOW - 1001);
    if (reason === "destroy") f.controller.destroy();
    f.controller.receive(response); expect(f.view().state).toBeNull(); expect(f.sent).toHaveLength(1);
  });
  it("ignores foreign correlations and late replies, but fails a malformed correlated response", () => {
    const f = fixture(); f.controller.query(); const response = f.state();
    f.controller.receive({ ...response, requestId: "z".repeat(24) }); expect(f.view().phase).toBe("pending");
    f.controller.receive({ ...response, keys: [] }); expect(f.view().phase).toBe("unavailable");
    f.controller.query(); f.controller.receive(response); expect(f.view().phase).toBe("pending");
    f.controller.receive(f.state()); expect(f.view().phase).toBe("ready");
  });
  it("lost removal confirmation does not claim success, retry, restore or stop other sources", () => {
    const f = fixture(); f.controller.query(); f.controller.receive(f.state());
    f.controller.revoke(source.consentId, f.view().state); f.time(5000); f.controller.tick();
    expect(f.view().phase).toBe("unavailable"); expect(f.sent).toHaveLength(2);
  });
  it("propagates bounded transport refusal and explicit denial as unavailable", () => {
    const f = fixture(); f.send.mockImplementationOnce(() => { throw new Error("backpressure"); });
    f.controller.query(); expect(f.view().phase).toBe("unavailable");
    f.controller.query(); f.controller.receive({ version: 1, type: "broadcast-source-moderation-unavailable", requestId: f.sent.at(-1).requestId });
    expect(f.view().phase).toBe("unavailable");
  });
  it("validates a closed bounded response and unique source bindings", () => {
    const f = fixture(); f.controller.query(); const state = f.state();
    expect(parseSourceModerationState(state)).not.toBeNull();
    for (const key of Object.keys(state)) { const bad = { ...state }; delete bad[key]; expect(parseSourceModerationState(bad)).toBeNull(); }
    for (const patch of [{ version: 2 }, { expiresAt: NOW + 5001 }, { observedAt: NaN },
      { sources: [source, source] }, { sources: Array(81).fill(source) }, { sources: [{ ...source, keys: [] }] },
      { sources: [{ ...source, sourceKind: "chat" }] }, { sources: [{ ...source, expiresAt: NOW }] }]) {
      expect(parseSourceModerationState({ ...state, ...patch })).toBeNull();
    }
  });
});
