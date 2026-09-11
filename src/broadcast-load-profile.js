export class BroadcastLoadProfileError extends Error {
  constructor(code) {
    super(code);
    this.name = "BroadcastLoadProfileError";
    this.code = code;
  }
}

function fail(code) { throw new BroadcastLoadProfileError(code); }

const FIELDS = ["profileId", "delivery", "publishers", "roomMembers", "originViewers", "codec", "renditions", "durationSeconds", "runtimeVerified"];

/** Origin-only planning envelope. Never a CDN, WAN or product maximum. */
export function normalizeBroadcastLoadProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== FIELDS.length || Object.keys(value).some(key => !FIELDS.includes(key))
    || typeof value.profileId !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(value.profileId)
    || value.delivery !== "origin-llhls"
    || !Number.isSafeInteger(value.publishers) || value.publishers !== 1
    || !Number.isSafeInteger(value.roomMembers) || value.roomMembers < 1 || value.roomMembers > 20
    || !Number.isSafeInteger(value.originViewers) || value.originViewers < 1 || value.originViewers > 50
    || value.codec !== "h264-aac"
    || !Number.isSafeInteger(value.renditions) || value.renditions < 1 || value.renditions > 3
    || !Number.isSafeInteger(value.durationSeconds) || value.durationSeconds < 5 || value.durationSeconds > 14_400
    || value.runtimeVerified !== false) fail("invalid_broadcast_load_profile");
  return Object.freeze({ ...value });
}
