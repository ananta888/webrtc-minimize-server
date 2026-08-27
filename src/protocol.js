export const MAX_SIGNAL_BYTES = 96 * 1024;
export const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,47}$/;
export const PEER_ID_PATTERN = /^[a-f0-9]{16}$/;
export const TRACK_ID_PATTERN = /^[A-Za-z0-9_=-]{1,128}$/;

const SOURCES = new Set(["microphone", "camera", "screen", "screen-audio"]);

export class ProtocolError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export function normalizeRoomId(value) {
  const roomId = String(value || "").trim().toLowerCase();
  if (!ROOM_ID_PATTERN.test(roomId)) {
    throw new ProtocolError("invalid_room", "Room codes need 6-48 lowercase letters, digits or dashes");
  }
  return roomId;
}

export function normalizeDisplayName(value) {
  const rawName = String(value || "");
  if (/[\u0000-\u001f\u007f]/.test(rawName)) {
    throw new ProtocolError("invalid_name", "Display names need 1-40 printable characters");
  }
  const name = rawName.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 40) {
    throw new ProtocolError("invalid_name", "Display names need 1-40 printable characters");
  }
  return name;
}

function parseJson(raw) {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
  if (bytes > MAX_SIGNAL_BYTES) throw new ProtocolError("message_too_large");
  let value;
  try {
    value = JSON.parse(raw.toString());
  } catch {
    throw new ProtocolError("invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("invalid_message");
  }
  return value;
}

function requireRecipient(value) {
  if (!PEER_ID_PATTERN.test(value.to || "")) throw new ProtocolError("invalid_recipient");
  return value.to;
}

function validateDescription(description) {
  if (!description || typeof description !== "object" || Array.isArray(description)) {
    throw new ProtocolError("invalid_description");
  }
  if (!new Set(["offer", "answer", "rollback"]).has(description.type)) {
    throw new ProtocolError("invalid_description_type");
  }
  if (description.type !== "rollback" && (
    typeof description.sdp !== "string" || description.sdp.length > 80_000
  )) throw new ProtocolError("invalid_sdp");
  return { type: description.type, ...(description.sdp ? { sdp: description.sdp } : {}) };
}

function validateCandidate(candidate) {
  if (candidate === null) return null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ProtocolError("invalid_candidate");
  }
  if (typeof candidate.candidate !== "string" || candidate.candidate.length > 4096) {
    throw new ProtocolError("invalid_candidate");
  }
  return {
    candidate: candidate.candidate,
    ...(typeof candidate.sdpMid === "string" ? { sdpMid: candidate.sdpMid.slice(0, 64) } : {}),
    ...(Number.isSafeInteger(candidate.sdpMLineIndex)
      ? { sdpMLineIndex: candidate.sdpMLineIndex }
      : {}),
    ...(typeof candidate.usernameFragment === "string"
      ? { usernameFragment: candidate.usernameFragment.slice(0, 256) }
      : {}),
  };
}

export function parseClientMessage(raw) {
  const value = parseJson(raw);
  if (value.type === "signal") {
    const to = requireRecipient(value);
    const hasDescription = Object.hasOwn(value, "description");
    const hasCandidate = Object.hasOwn(value, "candidate");
    if (hasDescription === hasCandidate) throw new ProtocolError("invalid_signal");
    return Object.freeze({
      type: "signal",
      to,
      ...(hasDescription
        ? { description: validateDescription(value.description) }
        : { candidate: validateCandidate(value.candidate) }),
    });
  }
  if (value.type === "media-state") {
    if (!SOURCES.has(value.source)) throw new ProtocolError("invalid_media_source");
    if (typeof value.active !== "boolean") throw new ProtocolError("invalid_media_state");
    if (value.active && !TRACK_ID_PATTERN.test(value.trackId || "")) {
      throw new ProtocolError("invalid_track_id");
    }
    return Object.freeze({
      type: "media-state",
      source: value.source,
      active: value.active,
      trackId: value.active ? value.trackId : null,
    });
  }
  if (value.type === "relay-consent") {
    if (Object.keys(value).some((key) => !new Set(["type", "enabled"]).has(key))) {
      throw new ProtocolError("unknown_message_field");
    }
    if (typeof value.enabled !== "boolean") throw new ProtocolError("invalid_relay_consent");
    return Object.freeze({ type: "relay-consent", enabled: value.enabled });
  }
  throw new ProtocolError("unknown_message_type");
}

export function encodeServerMessage(value) {
  return JSON.stringify({ version: 1, ...value });
}
