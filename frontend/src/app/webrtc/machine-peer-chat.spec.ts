import { describe, expect, it } from "vitest";
import { MachinePeerChatIngress } from "./machine-peer-chat";
import { parseMachinePeerChat } from "../../../../src/machine-chat-contract.js";

const now = 1_788_000_000_000, room = "room-aaaaaaaaaaaaaaaaaa", peer = "1111111111111111";
const message = (extra: object = {}) => ({ version: 2, type: "chat", roomId: room, membershipEpoch: 3,
  messageId: "a".repeat(32), replyTo: "", sentAt: now, text: "Hallo Ananta", ...extra });

describe("machine peer-chat ingress", () => {
  it("binds sender exclusively to the current connection, deduplicates and rejects foreign scope", () => {
    const ingress = new MachinePeerChatIngress(), raw = JSON.stringify(message());
    expect(ingress.accept(raw, peer, false, room, 3, now)).toMatchObject({ senderPeerId: peer, senderKind: "human" });
    expect(ingress.accept(raw, peer, false, room, 3, now)).toBeNull();
    expect(ingress.accept(raw, "2222222222222222", true, room, 3, now)?.senderKind).toBe("machine");
    expect(ingress.accept(raw, peer, false, room, 4, now)).toBeNull();
    expect(ingress.accept(raw, peer, false, "room-bbbbbbbbbbbbbbbbbb", 3, now)).toBeNull();
    expect(ingress.accept(raw, peer, false, room, 3, now + 30_001)).toBeNull();
    expect(ingress.accept(raw, peer, false, room, 3, now - 2001)).toBeNull();
  });
  it("rejects duplicate/escaped fields, version downgrade, invented sender and text limits", () => {
    const raw = JSON.stringify(message());
    for (const bad of [raw.replace('"version":2', '"version":2,"ver\\u0073ion":2'),
      JSON.stringify(message({ senderPeerId: peer })), JSON.stringify(message({ version: 1 })),
      JSON.stringify(message({ text: "😀".repeat(1001) })), JSON.stringify(message({ text: "\ud800" })),
      JSON.stringify(message({ replyTo: "a".repeat(32) })), raw + "\u00a0"]) {
      expect(() => parseMachinePeerChat(bad)).toThrow();
    }
    expect(parseMachinePeerChat(JSON.stringify(message({ text: "😀".repeat(1000) }))).text).toHaveLength(2000);
  });
  it("bounds rates, fences backwards clocks, and resets peer state on leave", () => {
    const ingress = new MachinePeerChatIngress();
    for (let i = 0; i < 60; i++) expect(ingress.accept(JSON.stringify(message({ messageId: i.toString(16).padStart(32, "0") })), peer, false, room, 3, now)).not.toBeNull();
    expect(ingress.accept(JSON.stringify(message()), peer, false, room, 3, now)).toBeNull();
    expect(ingress.accept(JSON.stringify(message()), peer, false, room, 3, now - 1)).toBeNull();
    ingress.removePeer(peer);
    expect(ingress.accept(JSON.stringify(message()), peer, false, room, 3, now)).not.toBeNull();
  });
});
