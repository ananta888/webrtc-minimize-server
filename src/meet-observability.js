const JOIN = Object.freeze(["admitted", "denied"]);
const MESSAGE = Object.freeze(["rate_limited", "protocol_error"]);
const TURN = Object.freeze(["infrastructure", "peer-edge"]);

export class MeetObservabilityError extends Error {
  constructor(code) {
    super(code);
    this.name = "MeetObservabilityError";
    this.code = code;
  }
}

function fail(code) {
  throw new MeetObservabilityError(code);
}

function increment(row, key) {
  if (!Object.hasOwn(row, key)) fail("invalid_meet_metric_label");
  row[key] += 1;
}

/** Content-free in-process counters. No room IDs, names, SDP, ICE or tokens. */
export class MeetObservability {
  #sessions = 0;
  #joins = { admitted: 0, denied: 0 };
  #messages = { rate_limited: 0, protocol_error: 0 };
  #turn = { infrastructure: 0, "peer-edge": 0 };
  #destroyed = false;

  #guard() {
    if (this.#destroyed) fail("invalid_meet_observability");
  }

  sessionOpen() {
    this.#guard();
    this.#sessions += 1;
  }

  sessionClose() {
    this.#guard();
    this.#sessions = Math.max(0, this.#sessions - 1);
  }

  join(result) {
    this.#guard();
    increment(this.#joins, result);
  }

  message(result) {
    this.#guard();
    increment(this.#messages, result);
  }

  turn(kind, count = 1) {
    this.#guard();
    if (!TURN.includes(kind) || !Number.isSafeInteger(count) || count < 0 || count > 24) fail("invalid_meet_metric_label");
    this.#turn[kind] += count;
  }

  snapshot() {
    this.#guard();
    return Object.freeze({
      sessions: this.#sessions,
      joins: Object.freeze({ ...this.#joins }),
      messages: Object.freeze({ ...this.#messages }),
      turnCredentials: Object.freeze({ ...this.#turn }),
    });
  }

  prometheus() {
    const snapshot = this.snapshot();
    return [
      `meet_signaling_sessions ${snapshot.sessions}`,
      ...JOIN.map((result) => `meet_joins_total{result="${result}"} ${snapshot.joins[result]}`),
      ...MESSAGE.map((result) => `meet_signaling_messages_total{result="${result}"} ${snapshot.messages[result]}`),
      ...TURN.map((kind) => `meet_turn_credentials_issued_total{class="${kind}"} ${snapshot.turnCredentials[kind]}`),
    ].join("\n") + "\n";
  }

  destroy() {
    this.#sessions = 0;
    this.#joins = { admitted: 0, denied: 0 };
    this.#messages = { rate_limited: 0, protocol_error: 0 };
    this.#turn = { infrastructure: 0, "peer-edge": 0 };
    this.#destroyed = true;
  }
}

export const MEET_OBSERVABILITY_LABELS = Object.freeze({ JOIN, MESSAGE, TURN });
