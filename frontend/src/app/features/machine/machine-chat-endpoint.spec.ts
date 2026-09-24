import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineChatEndpoint } from "./machine-chat-endpoint";
import { BoundPeerChat } from "../../webrtc/machine-peer-chat";
import { MachineChatAuthority } from "../../../../../src/machine-chat-queue.js";

const now = 1_788_000_000_000, human = "1111111111111111";
function fixture() {
  let authority: MachineChatAuthority = { chatRead: true, chatSend: true, scope: { origin: "https://meet.example",
    tenant_id: "tenant", project_id: "project", task_id: "task", session_id: "hub-session", runtime_id: "runtime",
    lease_id: "ms_" + "a".repeat(32), generation: 1, room_id: "room-aaaaaaaaaaaaaaaaaa", membership_epoch: 3,
    policy_revision: 1, own_peer_id: "2222222222222222", deadline_ms: now + 60_000 } };
  let listener: ((event: BoundPeerChat) => void) | null = null;
  let allowed = true, subscribing = () => {};
  const sendReply = vi.fn(() => ({ messageId: "f".repeat(32), queuedPeers: 1 }));
  const unsubscribe = vi.fn(() => { listener = null; });
  const endpoint = new MachineChatEndpoint({ authority: () => authority, sourceAllowed: () => allowed,
    subscribe: callback => { listener = callback; subscribing(); return unsubscribe; }, sendReply });
  const emit = (extra: Partial<BoundPeerChat> = {}) => listener?.({ version: 2, type: "chat",
    roomId: authority.scope.room_id, membershipEpoch: 3, messageId: "a".repeat(32), replyTo: "",
    sentAt: Date.now(), text: "Frage", senderPeerId: human, senderKind: "human", ...extra });
  return { endpoint, emit, sendReply, unsubscribe, callback: () => listener,
    onSubscribe: (callback: () => void) => { subscribing = callback; }, deny: () => { allowed = false; },
    sending: (value: boolean) => { authority = { ...authority, chatSend: value }; },
    change: (scope: object) => { authority = { ...authority, scope: { ...authority.scope, ...scope } }; },
    revoke: () => { authority = { ...authority, chatRead: false }; } };
}

describe("isolated machine chat endpoint", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it("exports only fresh subscribed events, bounds ACK and correlates one reply after delivery", () => {
    const f = fixture(); f.emit(); f.endpoint.open();
    expect(f.endpoint.poll().events).toEqual([]);
    f.emit(); f.emit();
    expect(() => f.endpoint.reply("a".repeat(32), "Antwort")).toThrow("meet_chat_reply_denied");
    const batch = f.endpoint.poll();
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0].event).toMatchObject({ session_id: "hub-session", generation: 1, sender_kind: "human", sender_peer_id: human });
    expect(() => f.endpoint.ack(2)).toThrow("meet_chat_ack_invalid");
    f.endpoint.ack(1); expect(f.endpoint.poll().events).toEqual([]);
    expect(f.endpoint.reply("a".repeat(32), "Antwort")).toEqual({ messageId: "f".repeat(32), queuedPeers: 1 });
    expect(() => f.endpoint.reply("a".repeat(32), "Andere Antwort")).toThrow();
    expect(f.sendReply).toHaveBeenCalledOnce(); f.endpoint.close();
  });
  it("ignores machine/own replies and denied sources; no text history on reopen", () => {
    const f = fixture(); f.endpoint.open();
    f.emit({ senderKind: "machine" }); f.emit({ replyTo: "b".repeat(32) });
    f.deny(); f.emit(); expect(f.endpoint.poll().events).toEqual([]);
    f.endpoint.close(); f.endpoint.open(); expect(f.endpoint.poll().events).toEqual([]); f.endpoint.close();
  });
  it("opens read-only, denies replies without consuming delivery and keeps receiving", () => {
    const f = fixture(); f.sending(false); f.endpoint.open(); f.emit();
    expect(f.endpoint.poll().events).toHaveLength(1);
    expect(() => f.endpoint.reply("a".repeat(32), "Antwort")).toThrow("meet_chat_reply_denied");
    expect(f.sendReply).not.toHaveBeenCalled(); expect(f.endpoint.status().open).toBe(true);
    f.endpoint.ack(1); expect(f.endpoint.poll().events).toHaveLength(0);
    f.sending(true); f.endpoint.reply("a".repeat(32), "Antwort");
    expect(f.sendReply).toHaveBeenCalledOnce(); f.endpoint.close();
  });
  it("checks current send authority after delivery without ending permitted reading", () => {
    const f = fixture(); f.endpoint.open(); f.emit(); f.endpoint.poll(); f.sending(false);
    expect(() => f.endpoint.reply("a".repeat(32), "Antwort")).toThrow("meet_chat_reply_denied");
    expect(f.sendReply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250); expect(f.endpoint.status().open).toBe(true);
    f.emit({ messageId: "b".repeat(32) }); expect(f.endpoint.poll().events).toHaveLength(2);
    f.change({ generation: 2 });
    expect(() => f.endpoint.reply("a".repeat(32), "Antwort")).toThrow("meet_chat_authority_changed");
    expect(f.endpoint.status().open).toBe(false);
  });
  it.each(["generation", "membership_epoch", "policy_revision"])("fences %s changes without replying on the old fence", field => {
    const f = fixture(); f.endpoint.open(); f.emit(); f.endpoint.poll(); f.change({ [field]: 9 });
    expect(() => f.endpoint.reply("a".repeat(32), "Antwort")).toThrow("meet_chat_authority_changed");
    expect(f.sendReply).not.toHaveBeenCalled(); expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.endpoint.status().open).toBe(false);
  });
  it("closes and wipes without polling within 250ms of permission revocation", () => {
    const f = fixture(); f.endpoint.open(); f.emit(); f.revoke(); vi.advanceTimersByTime(250);
    expect(f.endpoint.status()).toEqual({ open: false, error: "meet_chat_receive_denied" });
    expect(() => f.endpoint.poll()).toThrow(); expect(f.sendReply).not.toHaveBeenCalled();
  });
  it("reserves replies before a failed/uncertain send and rejects stale delivery", () => {
    const f = fixture(); f.endpoint.open(); f.emit(); f.endpoint.poll();
    f.sendReply.mockImplementation(() => { throw new Error("transport gone"); });
    expect(() => f.endpoint.reply("a".repeat(32), "Antwort")).toThrow("transport gone");
    expect(() => f.endpoint.reply("a".repeat(32), "Antwort")).toThrow("meet_chat_reply_denied");
    f.emit({ messageId: "b".repeat(32) }); f.endpoint.poll(); vi.advanceTimersByTime(30_001);
    expect(() => f.endpoint.reply("b".repeat(32), "Antwort")).toThrow(); f.endpoint.close();
  });
  it("keeps a delivered input answerable for the reply window after delivery, not after sentAt", () => {
    const f = fixture(); f.change({ deadline_ms: now + 600_000 }); f.endpoint.open();
    f.emit({ sentAt: now - 25_000 }); f.emit({ messageId: "b".repeat(32) });
    expect(f.endpoint.poll().events).toHaveLength(2);
    vi.advanceTimersByTime(21_600);
    f.endpoint.reply("a".repeat(32), "Antwort"); expect(f.sendReply).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(120_000 - 21_600 + 1);
    expect(() => f.endpoint.reply("b".repeat(32), "Antwort")).toThrow("meet_chat_reply_denied");
    expect(f.sendReply).toHaveBeenCalledOnce(); f.endpoint.close();
  });
  it("terminates on overflow instead of silently skipping inputs", () => {
    const f = fixture(); f.endpoint.open();
    for (let i = 0; i < 33; i++) f.emit({ messageId: i.toString(16).padStart(32, "0") });
    expect(f.endpoint.status()).toEqual({ open: false, error: "meet_chat_queue_exhausted" });
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it("does not retag an old subscription callback as a new lease generation", () => {
    const f = fixture(); f.endpoint.open(); const late = f.callback()!;
    f.emit(); f.endpoint.poll(); f.endpoint.close(); f.change({ generation: 2 });
    const current = f.endpoint.open();
    late({ version: 2, type: "chat", roomId: current.room_id, membershipEpoch: current.membership_epoch,
      messageId: "b".repeat(32), replyTo: "", sentAt: Date.now(), text: "Old callback",
      senderPeerId: human, senderKind: "human" });
    expect(f.endpoint.poll().events).toEqual([]);
    expect(f.endpoint.status().open).toBe(true);
    f.emit(); const fresh = f.endpoint.poll();
    expect(fresh.events).toHaveLength(1); expect(fresh.events[0].event.generation).toBe(2);
    f.endpoint.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans a subscription revoked synchronously during registration, without attaching a watchdog", () => {
    const f = fixture(); f.onSubscribe(() => { f.revoke(); f.emit(); });
    expect(() => f.endpoint.open()).toThrow("meet_chat_receive_denied");
    expect(f.endpoint.status().open).toBe(false); expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0); expect(f.sendReply).not.toHaveBeenCalled();
    f.endpoint.close(); expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it("a retired watchdog cannot close a new subscription", () => {
    const intervals = vi.spyOn(globalThis, "setInterval"), f = fixture(); f.endpoint.open();
    const retired = intervals.mock.calls.at(-1)![0] as () => void;
    f.endpoint.close(); f.endpoint.open(); f.revoke(); retired();
    expect(f.endpoint.status().open).toBe(true);
    vi.advanceTimersByTime(250); expect(f.endpoint.status().open).toBe(false);
    expect(vi.getTimerCount()).toBe(0); intervals.mockRestore();
  });
  it.each([false, true])("closes on a second sender reusing a delivered message ID (ack=%s)", acknowledged => {
    const f = fixture(); f.endpoint.open(); f.emit(); f.endpoint.poll();
    if (acknowledged) f.endpoint.ack(1);
    f.emit({ senderPeerId: "3333333333333333", text: "Different source" });
    expect(f.endpoint.status()).toEqual({ open: false, error: "meet_chat_message_id_conflict" });
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(() => f.endpoint.reply("a".repeat(32), "Antwort")).toThrow();
    expect(f.sendReply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    f.endpoint.open(); expect(f.endpoint.poll().events).toEqual([]);
    expect(() => f.endpoint.reply("a".repeat(32), "Antwort")).toThrow("meet_chat_reply_denied");
    f.emit({ senderPeerId: "3333333333333333", messageId: "c".repeat(32) });
    expect(f.endpoint.poll().events).toHaveLength(1); f.endpoint.close();
  });
});

describe("machine chat endpoint across a renewal fence", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  const id = (c: string) => c.repeat(32);
  const renew = (f: ReturnType<typeof fixture>, generation = 2) => { f.change({ generation }); vi.advanceTimersByTime(250); };

  it("re-delivers a polled but unacknowledged input after the reopen, bound to the new generation", () => {
    const f = fixture(); f.endpoint.open(); f.emit(); expect(f.endpoint.poll().events).toHaveLength(1);
    renew(f);
    expect(f.endpoint.status()).toEqual({ open: false, error: "meet_chat_authority_changed" });
    expect(() => f.endpoint.poll()).toThrow("meet_chat_closed");
    expect(f.endpoint.open().generation).toBe(2);
    const batch = f.endpoint.poll();
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0].event).toMatchObject({ message_id: id("a"), generation: 2, membership_epoch: 3, sender_peer_id: human });
    f.endpoint.ack(batch.events[0].cursor);
    f.endpoint.reply(id("a"), "Antwort"); expect(f.sendReply).toHaveBeenCalledOnce();
    f.endpoint.close(); expect(vi.getTimerCount()).toBe(0);
  });

  it("holds inputs arriving between the fence and the reopen, and the input that met the fence", () => {
    const f = fixture(); f.endpoint.open(); f.change({ generation: 2 });
    f.emit({ messageId: id("b") });
    expect(f.endpoint.status().open).toBe(false);
    f.emit({ messageId: id("c") }); f.emit({ messageId: id("c") });
    f.emit({ messageId: id("d"), senderKind: "machine" }); f.emit({ messageId: id("e"), replyTo: id("b") });
    vi.advanceTimersByTime(1000); f.endpoint.open();
    const batch = f.endpoint.poll();
    expect(batch.events.map(e => e.event.message_id)).toEqual([id("b"), id("c")]);
    expect(batch.events.every(e => e.event.generation === 2)).toBe(true);
    f.endpoint.reply(id("b"), "Eins"); f.endpoint.reply(id("c"), "Zwei");
    expect(f.sendReply).toHaveBeenCalledTimes(2); f.endpoint.close();
  });

  it("answers exactly once across repeated fences", () => {
    const f = fixture(); f.endpoint.open(); f.emit(); f.emit({ messageId: id("b") });
    const first = f.endpoint.poll(); f.endpoint.reply(id("a"), "Antwort");
    renew(f); f.emit(); f.endpoint.open();
    // "a" is answered: neither re-delivered nor answerable; "b" is still pending.
    expect(f.endpoint.poll().events.map(e => e.event.message_id)).toEqual([id("b")]);
    expect(() => f.endpoint.reply(id("a"), "Nochmal")).toThrow("meet_chat_reply_denied");
    renew(f, 3); f.endpoint.open(); f.emit();
    expect(f.endpoint.poll().events.map(e => e.event.message_id)).toEqual([id("b")]);
    f.endpoint.reply(id("b"), "Antwort"); renew(f, 4); f.endpoint.open();
    expect(f.endpoint.poll().events).toEqual([]);
    expect(() => f.endpoint.reply(id("b"), "Nochmal")).toThrow("meet_chat_reply_denied");
    expect(f.sendReply).toHaveBeenCalledTimes(2); expect(first.events).toHaveLength(2); f.endpoint.close();
  });

  it("keeps an acknowledged, unanswered input answerable once but does not re-deliver it", () => {
    const f = fixture(); f.endpoint.open(); f.emit(); f.endpoint.ack(f.endpoint.poll().events[0].cursor);
    renew(f); f.endpoint.open();
    expect(f.endpoint.poll().events).toEqual([]);
    expect(() => f.endpoint.reply(id("a"), "x".repeat(451))).toThrow("meet_chat_reply_denied");
    f.endpoint.reply(id("a"), "Antwort");
    expect(() => f.endpoint.reply(id("a"), "Antwort")).toThrow("meet_chat_reply_denied");
    expect(f.sendReply).toHaveBeenCalledOnce(); f.endpoint.close();
  });

  it.each([
    ["room", { room_id: "room-bbbbbbbbbbbbbbbbbb" }], ["session", { session_id: "other-session" }],
    ["lease", { lease_id: "ms_" + "b".repeat(32) }], ["own peer", { own_peer_id: "4444444444444444" }],
  ])("never carries inputs or reply identity into another conversation (%s)", (_name, scope) => {
    const f = fixture(); f.endpoint.open(); f.emit(); f.endpoint.poll();
    renew(f); f.change({ generation: 2, ...scope });
    vi.advanceTimersByTime(250);
    expect(f.endpoint.status()).toEqual({ open: false, error: "meet_chat_authority_changed" });
    f.endpoint.open();
    expect(f.endpoint.poll().events).toEqual([]);
    expect(() => f.endpoint.reply(id("a"), "Antwort")).toThrow("meet_chat_reply_denied");
    expect(f.sendReply).not.toHaveBeenCalled(); f.endpoint.close();
  });

  it("wipes a suspension on revocation within 250ms, on explicit close and after the age limit", () => {
    const revoked = fixture(); revoked.endpoint.open(); revoked.emit(); revoked.endpoint.poll(); renew(revoked);
    revoked.revoke(); vi.advanceTimersByTime(250);
    expect(revoked.endpoint.status()).toEqual({ open: false, error: "meet_chat_receive_denied" });
    expect(vi.getTimerCount()).toBe(0); expect(revoked.callback()).toBeNull();

    const closed = fixture(); closed.endpoint.open(); closed.emit(); renew(closed);
    closed.endpoint.close(); expect(vi.getTimerCount()).toBe(0); closed.endpoint.open();
    expect(closed.endpoint.poll().events).toEqual([]); closed.endpoint.close();

    const aged = fixture(); aged.endpoint.open(); aged.emit(); renew(aged);
    vi.advanceTimersByTime(30_250); expect(vi.getTimerCount()).toBe(0);
    aged.endpoint.open(); expect(aged.endpoint.poll().events).toEqual([]); aged.endpoint.close();
  });

  it("drops carried inputs past the age limit and re-checks the source at re-admission", () => {
    const f = fixture(); f.endpoint.open(); f.emit({ sentAt: now - 29_000 }); f.emit({ messageId: id("b") });
    renew(f); vi.advanceTimersByTime(1500); f.endpoint.open();
    expect(f.endpoint.poll().events.map(e => e.event.message_id)).toEqual([id("b")]);
    renew(f, 3); f.deny(); f.emit({ messageId: id("c") }); f.endpoint.open();
    expect(f.endpoint.poll().events).toEqual([]);
    expect(() => f.endpoint.reply(id("b"), "Antwort")).toThrow("meet_chat_reply_denied"); f.endpoint.close();
  });

  it("answers an input carried over a fence exactly once after a long model round (live regression)", () => {
    // Live: the input arrived while the companion was speaking, met the renewal
    // fence, was re-delivered by the reopened port ~20 s after sentAt, and the
    // model round took 21.6 s. The reply window must count from the delivery.
    const f = fixture(); f.endpoint.open(); vi.advanceTimersByTime(5000);
    f.emit(); vi.advanceTimersByTime(15_000);
    renew(f); vi.advanceTimersByTime(250); f.endpoint.open();
    f.emit(); // the same input once more on the live path: no second delivery
    const batch = f.endpoint.poll();
    expect(batch.events.map(e => e.event.message_id)).toEqual([id("a")]);
    vi.advanceTimersByTime(21_600);
    expect(f.endpoint.status()).toEqual({ open: true, error: "" });
    expect(f.endpoint.reply(id("a"), "Antwort")).toEqual({ messageId: id("f"), queuedPeers: 1 });
    expect(f.sendReply).toHaveBeenCalledWith("Antwort", id("a"));
    f.endpoint.ack(batch.events[0].cursor);
    expect(() => f.endpoint.reply(id("a"), "Antwort")).toThrow("meet_chat_reply_denied");
    renew(f, 3); f.emit(); f.endpoint.open();
    expect(f.endpoint.poll().events).toEqual([]);
    expect(() => f.endpoint.reply(id("a"), "Nochmal")).toThrow("meet_chat_reply_denied");
    expect(f.sendReply).toHaveBeenCalledOnce(); f.endpoint.close();
  });

  it("keeps the reply of a carried input possible when a fence meets the model round", () => {
    const f = fixture(); f.endpoint.open(); f.emit(); vi.advanceTimersByTime(20_000);
    renew(f); f.endpoint.open(); f.endpoint.poll(); vi.advanceTimersByTime(8000);
    renew(f, 3);
    expect(() => f.endpoint.reply(id("a"), "Antwort")).toThrow("meet_chat_closed");
    f.endpoint.open();
    expect(f.endpoint.poll().events.map(e => e.event.message_id)).toEqual([id("a")]);
    f.endpoint.reply(id("a"), "Antwort"); expect(f.sendReply).toHaveBeenCalledOnce(); f.endpoint.close();
  });

  it("bounds the standby hold and keeps message-ID bindings through the gap", () => {
    const f = fixture(); f.endpoint.open(); renew(f);
    for (let i = 0; i < 33; i++) f.emit({ messageId: i.toString(16).padStart(32, "0") });
    expect(f.endpoint.status()).toEqual({ open: false, error: "meet_chat_queue_exhausted" });
    expect(vi.getTimerCount()).toBe(0); f.endpoint.open(); expect(f.endpoint.poll().events).toEqual([]); f.endpoint.close();

    const g = fixture(); g.endpoint.open(); g.emit(); g.endpoint.poll(); renew(g);
    g.emit({ senderPeerId: "3333333333333333", text: "Different source" });
    expect(g.endpoint.status()).toEqual({ open: false, error: "meet_chat_message_id_conflict" });
    g.endpoint.open(); expect(g.endpoint.poll().events).toEqual([]);
    expect(() => g.endpoint.reply(id("a"), "Antwort")).toThrow("meet_chat_reply_denied"); g.endpoint.close();
  });
});
