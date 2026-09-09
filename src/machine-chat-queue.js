import { MACHINE_CHAT_LIMITS as limits, parseMachineChatEvent, validateMachineChatScope } from "./machine-chat-contract.js";

const fail = code => { throw new Error(code); };
const same = (left, right) => Object.keys(left).every(key => left[key] === right[key]);

/** Ephemeral endpoint-local transport. Authority must come from a trusted port,
 * never from an event, sender text or the controller polling this queue. */
export class MachineChatQueue {
  #authority; #clock; #scope; #items = []; #seen = new Map(); #bytes = 0;
  #serial = 0; #ack = 0; #delivered = 0; #closed = false; #lastNow = 0;
  constructor({ authority, clock = Date.now }) {
    if (typeof authority !== "function" || typeof clock !== "function") fail("meet_chat_authority_required");
    this.#authority = authority; this.#clock = clock;
    this.#scope = this.#current();
  }
  #current(requireSend = false) {
    if (this.#closed) fail("meet_chat_closed");
    let current;
    try { current = this.#authority(); } catch { this.close(); fail("meet_chat_authority_unavailable"); }
    if (!current || current.chatRead !== true || typeof current.chatSend !== "boolean") {
      this.close(); fail("meet_chat_receive_denied");
    }
    let scope;
    try { scope = validateMachineChatScope(current.scope); }
    catch (error) { this.close(); throw error; }
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < this.#lastNow || scope.deadline_ms <= now || this.#scope && !same(this.#scope, scope)) {
      this.close(); fail("meet_chat_authority_changed");
    }
    this.#lastNow = now;
    // A read-only subscription stays open. Sending is a separate, current right,
    // checked with the same scope snapshot before any reply is reserved or sent.
    if (requireSend && current.chatSend !== true) fail("meet_chat_reply_denied");
    return scope;
  }
  #prune() {
    const now = this.#clock();
    this.#items = this.#items.filter(item => {
      if (item.event.sent_at_ms >= now - limits.ageMs) return true;
      this.#bytes -= item.bytes; return false;
    });
  }
  push(raw) {
    const scope = this.#current(), event = parseMachineChatEvent(raw), now = this.#clock();
    if (event.session_id !== scope.session_id || event.room_id !== scope.room_id
      || event.generation !== scope.generation || event.membership_epoch !== scope.membership_epoch
      || event.sent_at_ms < now - limits.ageMs || event.sent_at_ms > now + limits.futureMs) fail("meet_chat_event_scope_invalid");
    if (event.sender_peer_id === scope.own_peer_id || event.sender_kind !== "human") return false;
    // Replies correlate by message ID, so a second connection must never reuse
    // that ID with a different sender. Keep this bounded binding through ACK and
    // age pruning, for exactly this subscription's immutable authority scope.
    const sender = this.#seen.get(event.message_id);
    if (sender !== undefined) {
      if (sender !== event.sender_peer_id) { this.close(); fail("meet_chat_message_id_conflict"); }
      return false;
    }
    this.#prune();
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    if (this.#items.length >= limits.queueEvents || this.#bytes + bytes > limits.queueBytes
      || this.#seen.size >= limits.dedupEntries || this.#serial >= Number.MAX_SAFE_INTEGER) {
      this.close(); fail("meet_chat_queue_exhausted");
    }
    this.#current();
    this.#seen.set(event.message_id, event.sender_peer_id); this.#bytes += bytes;
    this.#items.push({ cursor: ++this.#serial, event, bytes });
    return true;
  }
  poll() {
    this.#current(); this.#prune();
    const batch = this.#items.slice(0, limits.batchEvents);
    if (batch.length) this.#delivered = Math.max(this.#delivered, batch.at(-1).cursor);
    return Object.freeze({ schema: "ananta.meet-chat-batch.draft1", acknowledged: this.#ack,
      events: Object.freeze(batch.map(({ cursor, event }) => Object.freeze({ cursor, event }))) });
  }
  check() { this.#current(); this.#prune(); }
  checkReply() { this.#current(true); this.#prune(); }
  ack(cursor) {
    this.#current();
    if (!Number.isSafeInteger(cursor) || cursor < this.#ack || cursor > this.#delivered) fail("meet_chat_ack_invalid");
    this.#ack = cursor;
    while (this.#items.length && this.#items[0].cursor <= cursor) this.#bytes -= this.#items.shift().bytes;
  }
  close() {
    this.#closed = true; this.#items = []; this.#seen.clear(); this.#bytes = 0;
  }
}
