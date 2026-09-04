export const MAX_SIGNAL_BYTES = 96 * 1024;
export const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,47}$/;
export const PEER_ID_PATTERN = /^[a-f0-9]{16}$/;
export const TRACK_ID_PATTERN = /^[A-Za-z0-9_={}:-]{1,128}$/;

const SOURCES = new Set(["microphone", "camera", "screen", "screen-audio"]);
const BATTERY_STATES = new Set(["critical", "limited", "mains", "unknown"]);
const NETWORK_STATES = new Set(["constrained", "normal", "fast", "unknown"]);
const BASE64URL_COORDINATE = /^[A-Za-z0-9_-]{40,64}$/;
const NATIVE_PACKAGER_ID_PATTERN = /^pkr_[A-Za-z0-9_-]{16,64}$/;
const NATIVE_ASSIGNMENT_ID_PATTERN = /^asn_[A-Za-z0-9_-]{16,64}$/;
const BROADCAST_PROGRAM_ID_PATTERN = /^prg_[A-Za-z0-9_-]{16,64}$/;

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.has(key));
}

function requireNumber(value, name, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ProtocolError(`invalid_${name}`);
  }
  return value;
}

function requireInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ProtocolError(`invalid_${name}`);
  }
  return value;
}

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

export function validateDescription(description) {
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

export function validateCandidate(candidate) {
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
  if (value.type === "leave") {
    if (!hasOnlyKeys(value, new Set(["type"]))) {
      throw new ProtocolError("unknown_message_field");
    }
    return Object.freeze({ type: "leave" });
  }
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
  if (value.type === "native-packager-signal") {
    const allowed = new Set([
      "version", "type", "packagerId", "assignmentId", "programId", "programEpoch",
      "fencingRevision", "description", "candidate",
    ]);
    const hasDescription = Object.hasOwn(value, "description");
    const hasCandidate = Object.hasOwn(value, "candidate");
    if (!hasOnlyKeys(value, allowed) || value.version !== 1 || hasDescription === hasCandidate
      || !NATIVE_PACKAGER_ID_PATTERN.test(value.packagerId || "")
      || !NATIVE_ASSIGNMENT_ID_PATTERN.test(value.assignmentId || "")
      || !BROADCAST_PROGRAM_ID_PATTERN.test(value.programId || "")) {
      throw new ProtocolError("invalid_native_packager_signal");
    }
    return Object.freeze({
      version: 1,
      type: value.type,
      packagerId: value.packagerId,
      assignmentId: value.assignmentId,
      programId: value.programId,
      programEpoch: requireInteger(value.programEpoch, "native_program_epoch", 1, Number.MAX_SAFE_INTEGER),
      fencingRevision: requireInteger(value.fencingRevision, "native_fencing_revision", 1, Number.MAX_SAFE_INTEGER),
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
  if (value.type === "relay-capability") {
    if (!hasOnlyKeys(value, new Set([
      "type", "visible", "battery", "network", "selfCapacity",
    ]))) throw new ProtocolError("unknown_message_field");
    if (typeof value.visible !== "boolean") throw new ProtocolError("invalid_relay_visibility");
    if (!BATTERY_STATES.has(value.battery)) throw new ProtocolError("invalid_battery_state");
    if (!NETWORK_STATES.has(value.network)) throw new ProtocolError("invalid_network_state");
    return Object.freeze({
      type: "relay-capability",
      visible: value.visible,
      battery: value.battery,
      network: value.network,
      selfCapacity: requireInteger(value.selfCapacity, "relay_capacity", 0, 100),
    });
  }
  if (value.type === "relay-observation") {
    if (!hasOnlyKeys(value, new Set([
      "type", "relayPeerId", "routeEpoch", "sampleCount", "deliveryRatio", "delayMs",
      "observedCapacity",
    ]))) throw new ProtocolError("unknown_message_field");
    if (!PEER_ID_PATTERN.test(value.relayPeerId || "")) throw new ProtocolError("invalid_relay_peer");
    return Object.freeze({
      type: "relay-observation",
      relayPeerId: value.relayPeerId,
      routeEpoch: requireInteger(value.routeEpoch, "route_epoch", 1, Number.MAX_SAFE_INTEGER),
      sampleCount: requireInteger(value.sampleCount, "sample_count", 1, 10_000),
      deliveryRatio: requireNumber(value.deliveryRatio, "delivery_ratio", 0, 1),
      delayMs: requireNumber(value.delayMs, "relay_delay", 0, 60_000),
      observedCapacity: requireInteger(value.observedCapacity, "observed_capacity", 0, 100),
    });
  }
  if (value.type === "overlay-key") {
    if (!hasOnlyKeys(value, new Set(["type", "key"]))) throw new ProtocolError("unknown_message_field");
    const key = value.key;
    if (!key || typeof key !== "object" || Array.isArray(key)
      || !hasOnlyKeys(key, new Set(["kty", "crv", "x", "y", "ext"]))
      || key.kty !== "EC" || key.crv !== "P-256" || key.ext !== true
      || !BASE64URL_COORDINATE.test(key.x || "") || !BASE64URL_COORDINATE.test(key.y || "")) {
      throw new ProtocolError("invalid_overlay_key");
    }
    return Object.freeze({
      type: "overlay-key",
      key: Object.freeze({ kty: "EC", crv: "P-256", x: key.x, y: key.y, ext: true }),
    });
  }
  throw new ProtocolError("unknown_message_type");
}

export function encodeServerMessage(value) {
  return JSON.stringify({ version: 1, ...value });
}
