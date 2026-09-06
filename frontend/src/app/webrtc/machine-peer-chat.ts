import { MachinePeerChat, parseMachinePeerChat } from "../../../../src/machine-chat-contract.js";

export type BoundPeerChat = Readonly<MachinePeerChat & { senderPeerId: string; senderKind: "human" | "machine" }>;

/** Bounded ingress per current peer; no sender identity or authority from JSON. */
export class MachinePeerChatIngress {
  private peers = new Map<string, { since: number; count: number; lastNow: number; seen: Map<string, number> }>();
  accept(raw: unknown, senderPeerId: string, machine: boolean, roomId: string, epoch: number, now = Date.now()): BoundPeerChat | null {
    let event: MachinePeerChat;
    try { event = parseMachinePeerChat(raw); } catch { return null; }
    if (!/^[a-f0-9]{16}$/.test(senderPeerId) || !Number.isSafeInteger(now)
      || event.roomId !== roomId || event.membershipEpoch !== epoch
      || event.sentAt < now - 30_000 || event.sentAt > now + 2000) return null;
    let state = this.peers.get(senderPeerId);
    if (!state) {
      if (this.peers.size >= 20) return null;
      state = { since: now, count: 0, lastNow: now, seen: new Map() }; this.peers.set(senderPeerId, state);
    }
    if (now < state.lastNow) return null;
    state.lastNow = now;
    for (const [id, at] of state.seen) if (at < now - 32_000) state.seen.delete(id);
    if (state.seen.has(event.messageId)) return null;
    if (now - state.since >= 60_000) { state.since = now; state.count = 0; }
    if (state.count >= 60 || state.seen.size >= 128) return null;
    state.count++; state.seen.set(event.messageId, Math.max(now, event.sentAt));
    return Object.freeze({ ...event, senderPeerId, senderKind: machine ? "machine" : "human" });
  }
  removePeer(id: string): void { this.peers.delete(id); }
  clear(): void { this.peers.clear(); }
}

export function createMachinePeerChat(text: string, roomId: string, epoch: number, replyTo = ""): MachinePeerChat {
  const messageId = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
  return parseMachinePeerChat(JSON.stringify({ version: 2, type: "chat", roomId,
    membershipEpoch: epoch, messageId, replyTo, sentAt: Date.now(), text }));
}
