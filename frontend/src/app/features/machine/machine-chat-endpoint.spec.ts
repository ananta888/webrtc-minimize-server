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
  it.each(["generation", "membership_epoch", "policy_revision"])("fences %s changes and clears pending replies", field => {
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
