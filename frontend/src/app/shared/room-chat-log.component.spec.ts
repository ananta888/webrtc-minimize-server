import { describe, expect, it } from "vitest";
import { chatReplyReference, machineChatMessage, RoomChatEntry } from "./room-chat-log.component";

const entry: RoomChatEntry = { id: 1, author: "Ananta (KI)", text: "<script>not markup</script>", system: false };
describe("room chat presentation", () => {
  it("never infers machine identity from names, text or a reply reference", () => {
    expect(machineChatMessage(entry)).toBe(false);
    expect(machineChatMessage({ ...entry, replyTo: "a".repeat(32) })).toBe(false);
    expect(machineChatMessage({ ...entry, machine: "true" as never })).toBe(false);
    expect(machineChatMessage({ ...entry, author: "Someone", machine: true })).toBe(true);
    expect(machineChatMessage({ ...entry, machine: true, system: true })).toBe(false);
  });
  it("displays only an explicit reply reference without inferring processing or changing content", () => {
    for (const replyTo of [undefined, "", "a".repeat(31), "A".repeat(32), "<img src=x>"]) {
      expect(chatReplyReference({ ...entry, replyTo })).toBe(false);
    }
    const reply = Object.freeze({ ...entry, replyTo: "a".repeat(32) });
    expect(chatReplyReference(reply)).toBe(true);
    expect(chatReplyReference({ ...reply, system: true })).toBe(false);
    expect(reply.text).toBe(entry.text);
  });
});
