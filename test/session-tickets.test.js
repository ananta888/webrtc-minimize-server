import assert from "node:assert/strict";
import test from "node:test";

import { SessionTicketError, SessionTicketStore } from "../src/session-tickets.js";

test("SessionTicketStore issues origin-bound one-time tickets", () => {
  const store = new SessionTicketStore({ ttlMs: 5_000 });
  const issued = store.issue({ roomId: "room-alpha", origin: "https://rooms.test" }, 10_000);
  assert.equal(store.size, 1);
  assert.equal(store.consume(issued.ticket, { origin: "https://rooms.test", now: 12_000 }).roomId, "room-alpha");
  assert.equal(store.size, 0);
  assert.throws(() => store.consume(issued.ticket, { origin: "https://rooms.test", now: 12_001 }), SessionTicketError);
});
test("SessionTicketStore consumes mismatched and expired tickets fail-closed", () => {
  const store = new SessionTicketStore({ ttlMs: 1_000 });
  const wrongOrigin = store.issue({ origin: "https://rooms.test" }, 1_000);
  assert.throws(() => store.consume(wrongOrigin.ticket, { origin: "https://evil.test", now: 1_100 }), (error) => error.code === "session_ticket_origin_mismatch");
  assert.equal(store.size, 0);
  const expired = store.issue({ origin: "https://rooms.test" }, 1_000);
  assert.throws(() => store.consume(expired.ticket, { origin: "https://rooms.test", now: 2_001 }), (error) => error.code === "expired_session_ticket");
});
