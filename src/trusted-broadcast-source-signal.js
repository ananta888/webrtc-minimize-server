const COMMON = ["version", "type", "sourceLeaseId", "consentId", "assignmentId", "fencingRevision", "negotiationRevision", "sequence"];
const TYPES = new Set(["trusted-source-publisher-signal", "trusted-source-packager-signal"]);
const positive = (n, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n > 0 && n <= max;
const ref = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`).test(value);
function exact(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length
    && Object.keys(value).every(key => fields.includes(key));
}
export class TrustedSourceSignalError extends Error {
  constructor() { super("invalid_trusted_source_signal"); this.code = this.message; }
}
const fail = () => { throw new TrustedSourceSignalError(); };

// Separate closed protocol: no target IDs supplied by the sender, no keys and
// no arbitrary SDP extension properties silently stripped by generic validation.
export function parseTrustedSourceSignal(value, expectedType) {
  const kind = Object.hasOwn(value || {}, "description") ? "description" : "candidate";
  if (!TYPES.has(expectedType) || !exact(value, [...COMMON, kind]) || value.version !== 1 || value.type !== expectedType
    || !ref(value.sourceLeaseId, "sls") || !ref(value.consentId, "cns") || !ref(value.assignmentId, "asn")
    || !positive(value.fencingRevision) || !positive(value.negotiationRevision, 16) || !positive(value.sequence, 129)) fail();
  let payload;
  if (kind === "description") {
    const description = value.description;
    if (!exact(description, ["type", "sdp"]) || description.type !== (expectedType === "trusted-source-publisher-signal" ? "offer" : "answer")
      || typeof description.sdp !== "string" || description.sdp.length === 0 || Buffer.byteLength(description.sdp) > 16384) fail();
    payload = Object.freeze({ ...description });
  } else {
    const c = value.candidate;
    if (c !== null && (!c || typeof c !== "object" || Array.isArray(c)
      || Object.keys(c).some(key => !["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"].includes(key))
      || typeof c.candidate !== "string" || Buffer.byteLength(c.candidate) > 4096
      || ["sdpMid", "usernameFragment"].some(key => Object.hasOwn(c, key) && c[key] !== null
        && (typeof c[key] !== "string" || Buffer.byteLength(c[key]) > 64))
      || Object.hasOwn(c, "sdpMLineIndex") && c.sdpMLineIndex !== null
        && (!Number.isSafeInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 15))) fail();
    payload = c === null ? null : Object.freeze({ ...c });
  }
  const result = { ...Object.fromEntries(COMMON.map(key => [key, value[key]])), [kind]: payload };
  // Reserve 1 KiB for server-added endpoint references. Escaped SDP can be
  // much larger than its decoded UTF-8 size and must not close the target WS.
  if (Buffer.byteLength(JSON.stringify(result)) > 31 * 1024) fail();
  return Object.freeze(result);
}

// A single bounded negotiation owner per source connection. No room-level
// orchestration, authority or timer; the broker checks current scope first.
export class TrustedSourceNegotiation {
  #revision = 0; #publisherSequence = 0; #packagerSequence = 0; #answered = false;
  #bytes = 0; #windowAt = 0; #windowCount = 0;
  accept(message, now) {
    const publisher = message.type === "trusted-source-publisher-signal";
    const description = Object.hasOwn(message, "description");
    const size = Buffer.byteLength(JSON.stringify(message));
    if (now >= this.#windowAt + 10000) { this.#windowAt = now; this.#windowCount = 0; }
    if (++this.#windowCount > 64 || this.#bytes + size > 512 * 1024) return false;
    if (publisher && description) {
      if (message.negotiationRevision !== this.#revision + 1 || message.sequence !== 1
        || this.#revision > 0 && !this.#answered) return false;
      this.#revision = message.negotiationRevision; this.#publisherSequence = 1; this.#packagerSequence = 0; this.#answered = false;
    } else {
      if (!this.#revision || message.negotiationRevision !== this.#revision) return false;
      const expected = publisher ? this.#publisherSequence + 1 : this.#packagerSequence + 1;
      if (message.sequence !== expected || !publisher && (description ? this.#answered : !this.#answered)) return false;
      if (publisher) this.#publisherSequence = message.sequence;
      else { this.#packagerSequence = message.sequence; if (description) this.#answered = true; }
    }
    this.#bytes += size;
    return true;
  }
}
