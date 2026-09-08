import { MachineChatScope } from "../../../../../src/machine-chat-contract.js";
import { MachineChatAuthority, MachineChatQueue } from "../../../../../src/machine-chat-queue.js";
import { BoundPeerChat } from "../../webrtc/machine-peer-chat";

interface ChatEndpointPorts {
  readonly authority: () => MachineChatAuthority;
  readonly subscribe: (listener: (event: BoundPeerChat) => void) => () => void;
  readonly sourceAllowed: (peerId: string) => boolean;
  readonly sendReply: (text: string, replyTo: string) => Readonly<{ messageId: string; queuedPeers: number }>;
  readonly clock?: () => number;
}

/** One ephemeral, isolated controller subscription. No replay/history or LLM policy. */
export class MachineChatEndpoint {
  private queue: MachineChatQueue | null = null;
  private scope: MachineChatScope | null = null;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private delivered = new Map<string, { sender: string; at: number }>();
  private replied = new Set<string>();
  private readonly clock: () => number;
  private error = "";
  constructor(private readonly ports: ChatEndpointPorts) { this.clock = ports.clock || Date.now; }
  open(): MachineChatScope {
    this.close(); this.error = "";
    try {
      this.queue = new MachineChatQueue({ authority: this.ports.authority, clock: this.clock });
      this.scope = Object.freeze({ ...this.ports.authority().scope });
      this.queue.check();
      this.unsubscribe = this.ports.subscribe(event => this.accept(event));
      this.timer = setInterval(() => { try { this.check(); } catch { /* Already closed and sanitized. */ } }, 250);
      return this.scope;
    } catch (error) { this.fail(error); }
  }
  private check(): MachineChatQueue {
    try {
      if (!this.queue) throw new Error("meet_chat_closed");
      this.queue.check();
      for (const [id, value] of this.delivered) if (value.at < this.clock() - 30_000) this.delivered.delete(id);
      return this.queue;
    } catch (error) { this.fail(error); }
  }
  private accept(event: BoundPeerChat): void {
    try {
      const queue = this.check(), scope = this.scope!;
      if (event.senderKind !== "human" || event.replyTo || !this.ports.sourceAllowed(event.senderPeerId)) return;
      queue.push(JSON.stringify({ schema: "ananta.meet-chat-event.draft1", session_id: scope.session_id,
        generation: scope.generation, room_id: event.roomId, membership_epoch: event.membershipEpoch,
        message_id: event.messageId, sender_peer_id: event.senderPeerId, sender_kind: event.senderKind,
        sent_at_ms: event.sentAt, text: event.text }));
    } catch (error) { try { this.fail(error); } catch { /* Never leak text or disrupt media transport. */ } }
  }
  poll() {
    const batch = this.check().poll();
    for (const { event } of batch.events) {
      if (!this.delivered.has(event.message_id) && this.delivered.size >= 32) this.fail(new Error("meet_chat_reply_queue_exhausted"));
      this.delivered.set(event.message_id, { sender: event.sender_peer_id, at: event.sent_at_ms });
    }
    return batch;
  }
  ack(cursor: number): void { this.check().ack(cursor); }
  reply(messageId: string, text: string) {
    const queue = this.check();
    try { queue.checkReply(); }
    catch (error) {
      if (error instanceof Error && error.message === "meet_chat_reply_denied") throw error;
      this.fail(error);
    }
    const input = this.delivered.get(messageId);
    if (!input || this.replied.has(messageId) || !this.ports.sourceAllowed(input.sender)
      || typeof text !== "string" || !text.trim() || [...text].length > 450) throw new Error("meet_chat_reply_denied");
    if (this.replied.size >= 512) this.fail(new Error("meet_chat_reply_budget_exhausted"));
    // Reserve before send: uncertain/partial delivery must never be retried as a new answer.
    this.replied.add(messageId); this.delivered.delete(messageId);
    return this.ports.sendReply(text, messageId);
  }
  status() { return Object.freeze({ open: Boolean(this.queue), error: this.error }); }
  close(): void {
    this.queue?.close(); this.queue = null; this.scope = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    this.delivered.clear(); this.replied.clear();
  }
  private fail(error: unknown): never {
    this.error = error instanceof Error && /^meet_chat_[a-z_]{1,64}$/.test(error.message) ? error.message : "meet_chat_endpoint_failed";
    this.close(); throw new Error(this.error);
  }
}
