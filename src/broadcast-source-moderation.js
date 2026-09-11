import { TrustedBroadcastSourceError } from "./trusted-broadcast-source-grants.js";

const BASE = ["version", "type", "requestId", "programId", "programEpoch"];
const positive = n => Number.isSafeInteger(n) && n > 0;
export function parseSourceModeration(value) {
  const revoke = value?.type === "broadcast-source-moderation-revoke";
  const fields = revoke ? [...BASE, "consentId", "programRevision", "fencingRevision"] : BASE;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
    || (!revoke && value.type !== "broadcast-source-moderation-query")
    || Object.keys(value).length !== fields.length || Object.keys(value).some(k => !fields.includes(k))
    || typeof value.requestId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(value.requestId)
    || typeof value.programId !== "string" || !/^prg_[A-Za-z0-9_-]{16,64}$/.test(value.programId)
    || !positive(value.programEpoch) || (revoke && (typeof value.consentId !== "string"
      || !/^cns_[A-Za-z0-9_-]{16,64}$/.test(value.consentId) || !positive(value.programRevision)
      || !positive(value.fencingRevision)))) throw new TrustedBroadcastSourceError("invalid_source_moderation", 400);
  return Object.freeze(Object.fromEntries(fields.map(k => [k, value[k]])));
}

/** Separate namespace: owner receipts must never be interpreted as publisher commands. */
export function executeSourceModeration(grants, broker, actor, identity, raw) {
  const message = parseSourceModeration(raw);
  if (message.type === "broadcast-source-moderation-query") {
    const state = grants.listForOwner(identity, actor, message.programId, message.programEpoch);
    broker.tick();
    return Object.freeze({ version: 1, type: "broadcast-source-moderation-state", requestId: message.requestId, ...state });
  }
  grants.revokeForOwner(identity, actor, message);
  broker.tick();
  return Object.freeze({ version: 1, type: "broadcast-source-moderation-revoked", requestId: message.requestId,
    programId: message.programId, programEpoch: message.programEpoch, consentId: message.consentId });
}
