// Browser-neutral contract shared by the isolated Meet client and Node fixtures.
// Parsing is NOT admission. No tokens, policy decisions or content logging here.
export const MACHINE_CHAT_SCHEMA = "ananta.meet-chat-event.draft1";
export const MACHINE_CHAT_LIMITS = Object.freeze({ eventBytes: 8192, textBytes: 4000,
  textCharacters: 2000, ageMs: 30_000, futureMs: 2000, queueEvents: 32, batchEvents: 8,
  queueBytes: 131_072, dedupEntries: 512 });
const fields = ["schema", "session_id", "generation", "room_id", "membership_epoch",
  "message_id", "sender_peer_id", "sender_kind", "sent_at_ms", "text"];
const identifier = /^[A-Za-z0-9_.:-]{1,160}$/;
const encoder = new TextEncoder();
const wellFormed = text => typeof text === "string" && ![...text].some(c => /^[\uD800-\uDFFF]$/.test(c));
const fail = code => { throw new Error(code); };

// This contract is deliberately flat. Tokenize scalar values so duplicate keys,
// including escaped aliases, cannot disappear in JSON.parse's last-write wins.
function flatJson(raw, allowed = fields) {
  const token = /[\x20\t\r\n]*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}:,])/y;
  let offset = 0;
  const next = () => {
    token.lastIndex = offset;
    const match = token.exec(raw);
    if (!match) fail("meet_chat_event_invalid");
    offset = token.lastIndex;
    return match[1];
  };
  if (next() !== "{") fail("meet_chat_event_contract_invalid");
  const value = Object.create(null);
  let key = next();
  if (key !== "}") for (;;) {
    if (!key.startsWith('"')) fail("meet_chat_event_invalid");
    const name = JSON.parse(key);
    if (Object.hasOwn(value, name)) fail("meet_chat_duplicate_field");
    if (!allowed.includes(name)) fail("meet_chat_event_contract_invalid");
    if (next() !== ":") fail("meet_chat_event_invalid");
    const scalar = next();
    if (["{", "}", ":", ","].includes(scalar)) fail("meet_chat_event_invalid");
    value[name] = JSON.parse(scalar);
    const separator = next();
    if (separator === "}") break;
    if (separator !== ",") fail("meet_chat_event_invalid");
    key = next();
  }
  if (!/^[\x20\t\r\n]*$/.test(raw.slice(offset))) fail("meet_chat_event_invalid");
  return value;
}

// Additive DataChannel wire format. Sender identity is deliberately absent:
// it is supplied by the authenticated, current PeerConnection membership.
export function parseMachinePeerChat(raw) {
  const names = ["version", "type", "roomId", "membershipEpoch", "messageId", "replyTo", "sentAt", "text"];
  if (!wellFormed(raw) || !raw.length || encoder.encode(raw).length > MACHINE_CHAT_LIMITS.eventBytes) fail("meet_chat_event_size");
  const value = flatJson(raw, names);
  if (Object.keys(value).length !== names.length || value.version !== 2 || value.type !== "chat"
    || typeof value.roomId !== "string" || !/^room-[a-f0-9]{18}$/.test(value.roomId)
    || !Number.isSafeInteger(value.membershipEpoch) || value.membershipEpoch < 1
    || !Number.isSafeInteger(value.sentAt) || value.sentAt < 1
    || typeof value.messageId !== "string" || !/^[a-f0-9]{32}$/.test(value.messageId)
    || typeof value.replyTo !== "string" || value.replyTo !== "" && !/^[a-f0-9]{32}$/.test(value.replyTo)
    || value.replyTo === value.messageId) fail("meet_chat_event_contract_invalid");
  const text = value.text;
  if (!wellFormed(text) || !text.trim() || [...text].length > MACHINE_CHAT_LIMITS.textCharacters
    || encoder.encode(text).length > MACHINE_CHAT_LIMITS.textBytes || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail("meet_chat_text_invalid");
  return Object.freeze({ ...value });
}

export function parseMachineChatEvent(raw) {
  if (raw instanceof Uint8Array) {
    if (!raw.length || raw.length > MACHINE_CHAT_LIMITS.eventBytes) fail("meet_chat_event_size");
    try { raw = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
    catch { fail("meet_chat_event_invalid"); }
  }
  if (!wellFormed(raw)) fail("meet_chat_event_invalid");
  if (!raw.length || encoder.encode(raw).length > MACHINE_CHAT_LIMITS.eventBytes) fail("meet_chat_event_size");
  const value = flatJson(raw);
  if (Object.keys(value).length !== fields.length || value.schema !== MACHINE_CHAT_SCHEMA) fail("meet_chat_event_contract_invalid");
  for (const key of ["session_id", "message_id", "sender_peer_id"]) {
    if (typeof value[key] !== "string" || !identifier.test(value[key])) fail("meet_chat_identifier_invalid");
  }
  for (const key of ["generation", "membership_epoch", "sent_at_ms"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) fail("meet_chat_integer_invalid");
  }
  if (typeof value.room_id !== "string" || !/^room-[a-f0-9]{18}$/.test(value.room_id)) fail("meet_chat_room_invalid");
  if (!["human", "machine", "unknown"].includes(value.sender_kind)) fail("meet_chat_sender_invalid");
  const text = value.text;
  if (!wellFormed(text) || !text.trim() || [...text].length > MACHINE_CHAT_LIMITS.textCharacters
    || encoder.encode(text).length > MACHINE_CHAT_LIMITS.textBytes || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
    fail("meet_chat_text_invalid");
  }
  return Object.freeze({ ...value });
}

export function validateMachineChatScope(value) {
  const names = ["origin", "tenant_id", "project_id", "task_id", "session_id", "runtime_id", "lease_id",
    "generation", "room_id", "membership_epoch", "policy_revision", "own_peer_id", "deadline_ms"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== names.length
    || Object.keys(value).some(key => !names.includes(key))) fail("meet_chat_scope_invalid");
  for (const key of ["tenant_id", "project_id", "task_id", "session_id", "runtime_id", "lease_id", "own_peer_id"]) {
    if (typeof value[key] !== "string" || !identifier.test(value[key])) fail("meet_chat_scope_invalid");
  }
  for (const key of ["generation", "membership_epoch", "policy_revision", "deadline_ms"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) fail("meet_chat_scope_invalid");
  }
  let url;
  try { url = new URL(value.origin); } catch { fail("meet_chat_scope_invalid"); }
  if (url.protocol !== "https:" || url.origin !== value.origin || url.username || url.password
    || typeof value.room_id !== "string" || !/^room-[a-f0-9]{18}$/.test(value.room_id)) fail("meet_chat_scope_invalid");
  return Object.freeze({ ...value });
}
