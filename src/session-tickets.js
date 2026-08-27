import crypto from "node:crypto";

export class SessionTicketError extends Error {
  constructor(code) {
    super(code);
    this.name = "SessionTicketError";
    this.code = code;
  }
}
export class SessionTicketStore {
  #tickets = new Map();
  #ttlMs;

  constructor({ ttlMs = 30_000 } = {}) {
    this.#ttlMs = ttlMs;
  }

  issue(claims, now = Date.now()) {
    const ticket = crypto.randomBytes(32).toString("base64url");
    this.#tickets.set(ticket, Object.freeze({ ...claims, expiresAt: now + this.#ttlMs }));
    return Object.freeze({ ticket, expiresAt: now + this.#ttlMs });
  }

  consume(ticket, { origin, now = Date.now() } = {}) {
    const claims = this.#tickets.get(ticket);
    if (!claims) throw new SessionTicketError("invalid_session_ticket");
    this.#tickets.delete(ticket);
    if (claims.expiresAt < now) throw new SessionTicketError("expired_session_ticket");
    if (claims.origin && claims.origin !== origin) throw new SessionTicketError("session_ticket_origin_mismatch");
    return claims;
  }

  prune(now = Date.now()) {
    for (const [ticket, claims] of this.#tickets) {
      if (claims.expiresAt < now) this.#tickets.delete(ticket);
    }
  }

  get size() {
    return this.#tickets.size;
  }
}
