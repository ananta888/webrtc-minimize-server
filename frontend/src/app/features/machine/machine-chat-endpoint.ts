import { MACHINE_CHAT_LIMITS, MachineChatScope } from "../../../../../src/machine-chat-contract.js";
import { MachineChatAuthority, MachineChatQueue } from "../../../../../src/machine-chat-queue.js";
import { BoundPeerChat } from "../../webrtc/machine-peer-chat";

interface ChatEndpointPorts {
  readonly authority: () => MachineChatAuthority;
  readonly subscribe: (listener: (event: BoundPeerChat) => void) => () => void;
  readonly sourceAllowed: (peerId: string) => boolean;
  readonly sendReply: (text: string, replyTo: string) => Readonly<{ messageId: string; queuedPeers: number }>;
  readonly clock?: () => number;
}

// A lease renewal or membership/policy update keeps these fields. Anything else
// is another conversation and never inherits pending inputs or reply identity.
const continuity = ["origin", "tenant_id", "project_id", "task_id", "session_id", "runtime_id",
  "lease_id", "room_id", "own_peer_id"] as const;
const continues = (previous: MachineChatScope, next: MachineChatScope) =>
  continuity.every(key => previous[key] === next[key]) && next.generation >= previous.generation;
const SUSPEND_MS = MACHINE_CHAT_LIMITS.ageMs;

/** One isolated controller subscription. No history or LLM policy: only inputs
 * this endpoint accepted itself and that were not yet ACKed/answered survive a
 * fence (lease renewal, membership or policy revision) of the same conversation,
 * bounded, age-limited and re-admitted under the next open()'s current scope. */
export class MachineChatEndpoint {
  private queue: MachineChatQueue | null = null;
  private scope: MachineChatScope | null = null;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private delivered = new Map<string, { sender: string; at: number }>();
  private replied = new Set<string>();
  // Accepted, not yet ACKed inputs (cursor once polled) of this conversation.
  private pending = new Map<string, { event: BoundPeerChat; cursor: number }>();
  // Scope of a fenced subscription; a standby listener keeps accepting until open().
  private retained: { scope: MachineChatScope; until: number } | null = null;
  private readonly clock: () => number;
  private error = "";
  constructor(private readonly ports: ChatEndpointPorts) { this.clock = ports.clock || Date.now; }
  open(): MachineChatScope {
    const previous = this.retained?.scope || this.scope;
    this.detach(); this.error = "";
    let carried: BoundPeerChat[] = [];
    try {
      this.queue = new MachineChatQueue({ authority: this.ports.authority, clock: this.clock });
      this.scope = Object.freeze({ ...this.ports.authority().scope });
      this.queue.check();
      if (!previous || !continues(previous, this.scope)) this.wipe();
      const queue = this.queue;
      carried = [...this.pending.values()].map(item => item.event); this.pending.clear();
      const unsubscribe = this.ports.subscribe(event => { if (this.queue === queue) this.accept(event); });
      // A synchronous first callback may have revoked this owner while the
      // subscription was being registered. Never attach its cleanup to a successor.
      if (this.queue !== queue) { unsubscribe(); throw new Error(this.error || "meet_chat_closed"); }
      this.unsubscribe = unsubscribe;
      // Re-admission runs the same human/source/scope/limit checks as live input.
      for (const event of carried) if (this.queue === queue) this.accept(event, true);
      if (this.queue !== queue) throw new Error(this.error || "meet_chat_closed");
      this.timer = setInterval(() => {
        if (this.queue !== queue) return;
        try { this.check(); } catch { /* Already closed and sanitized. */ }
      }, 250);
      return this.scope;
    } catch (error) {
      try { this.fail(error); }
      catch (sanitized) {
        // A reopen fenced again mid-way hands carried inputs back to its suspension.
        for (const event of carried) try { this.hold(event); } catch { /* Suspended owners only. */ }
        throw sanitized;
      }
    }
  }
  private check(): MachineChatQueue {
    // A closed or suspended endpoint rejects controller calls without touching
    // what a suspension still holds for the next open().
    if (!this.queue) throw new Error("meet_chat_closed");
    try {
      this.queue.check();
      this.expire();
      return this.queue;
    } catch (error) { this.fail(error); }
  }
  private expire(): void {
    const now = this.clock();
    for (const [id, value] of this.delivered) if (value.at < now - 30_000) this.delivered.delete(id);
    for (const [id, value] of this.pending) if (value.event.sentAt < now - MACHINE_CHAT_LIMITS.ageMs) this.pending.delete(id);
  }
  private admissible(event: BoundPeerChat, carried: boolean): boolean {
    return event.senderKind === "human" && !event.replyTo && !this.replied.has(event.messageId)
      && (!carried || event.sentAt >= this.clock() - MACHINE_CHAT_LIMITS.ageMs) && this.ports.sourceAllowed(event.senderPeerId);
  }
  private accept(event: BoundPeerChat, carried = false): void {
    try {
      const queue = this.check(), scope = this.scope!;
      if (!this.admissible(event, carried)) return;
      // A carried input was admitted by this endpoint for the same conversation;
      // it is bound to the current fence, never to a foreign scope.
      if (!queue.push(JSON.stringify({ schema: "ananta.meet-chat-event.draft1", session_id: scope.session_id,
        generation: scope.generation, room_id: event.roomId,
        membership_epoch: carried ? scope.membership_epoch : event.membershipEpoch,
        message_id: event.messageId, sender_peer_id: event.senderPeerId, sender_kind: event.senderKind,
        sent_at_ms: event.sentAt, text: event.text }))) return;
      this.pending.set(event.messageId, { event, cursor: 0 });
    } catch (error) {
      try { this.fail(error); } catch { /* Never leak text or disrupt media transport. */ }
      // The input that met the fence belongs to the suspended conversation.
      try { this.hold(event); } catch { /* Same. */ }
    }
  }
  poll() {
    const batch = this.check().poll();
    for (const { cursor, event } of batch.events) {
      if (!this.delivered.has(event.message_id) && this.delivered.size >= 32) this.fail(new Error("meet_chat_reply_queue_exhausted"));
      this.delivered.set(event.message_id, { sender: event.sender_peer_id, at: event.sent_at_ms });
      const item = this.pending.get(event.message_id);
      if (item) item.cursor = cursor;
    }
    return batch;
  }
  ack(cursor: number): void {
    this.check().ack(cursor);
    for (const [id, item] of this.pending) if (item.cursor && item.cursor <= cursor) this.pending.delete(id);
  }
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
    this.replied.add(messageId); this.delivered.delete(messageId); this.pending.delete(messageId);
    return this.ports.sendReply(text, messageId);
  }
  status() { return Object.freeze({ open: Boolean(this.queue), error: this.error }); }
  /** Explicit end of the conversation: nothing survives into a later open(). */
  close(): void { this.detach(); this.wipe(); }
  private detach(): void {
    this.queue?.close(); this.queue = null; this.scope = null; this.retained = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer); this.timer = null;
  }
  private wipe(): void { this.delivered.clear(); this.replied.clear(); this.pending.clear(); }
  private fail(error: unknown): never {
    // Re-raised after this owner was already fenced: keep the suspension intact.
    if (!this.queue && this.retained) throw new Error(this.error);
    this.error = error instanceof Error && /^meet_chat_[a-z_]{1,64}$/.test(error.message) ? error.message : "meet_chat_endpoint_failed";
    const scope = this.scope;
    // Only a fence of a live subscription suspends; revocation, conflict,
    // overflow and invalid input still close and wipe everything.
    if (this.error === "meet_chat_authority_changed" && scope) this.suspend(scope);
    else this.close();
    throw new Error(this.error);
  }
  private suspend(scope: MachineChatScope): void {
    this.detach();
    const retained = { scope, until: this.clock() + SUSPEND_MS };
    this.retained = retained;
    // The gap between the fence and the controller's reopen: keep accepting
    // this conversation's human inputs, bounded like the queue, never polled.
    try { this.unsubscribe = this.ports.subscribe(event => { try { this.hold(event, retained); } catch { /* Never disrupt transport. */ } }); }
    catch { /* Without a standby slot, already accepted inputs still carry over. */ }
    if (this.retained !== retained) { this.unsubscribe?.(); this.unsubscribe = null; return; }
    // Revocation or a different conversation still wipes within 250ms, and an
    // unclaimed suspension ends after the input age limit.
    this.timer = setInterval(() => {
      if (this.retained !== retained) return;
      let current: MachineChatAuthority;
      try { current = this.ports.authority(); } catch { return this.end("meet_chat_receive_denied"); }
      if (!current || current.chatRead !== true) return this.end("meet_chat_receive_denied");
      if (!current.scope || !continues(scope, current.scope)) return this.end("meet_chat_authority_changed");
      if (this.clock() > retained.until) return this.end("meet_chat_closed");
      this.expire();
    }, 250);
  }
  private hold(event: BoundPeerChat, retained = this.retained): void {
    if (!retained || this.retained !== retained || event.roomId !== retained.scope.room_id
      || !this.admissible(event, true)) return;
    // Replies correlate by message ID: the same binding rule as the queue applies.
    const known = this.pending.get(event.messageId)?.event.senderPeerId ?? this.delivered.get(event.messageId)?.sender;
    if (known !== undefined) { if (known !== event.senderPeerId) this.end("meet_chat_message_id_conflict"); return; }
    if (this.pending.size >= MACHINE_CHAT_LIMITS.queueEvents) return this.end("meet_chat_queue_exhausted");
    this.pending.set(event.messageId, { event, cursor: 0 });
  }
  private end(code: string): void { this.close(); this.error = code; }
}
