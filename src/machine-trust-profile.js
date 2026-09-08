import { machineCapabilityCeiling } from "./machine-capabilities.js";
import { parseMachineTrustJson } from "./machine-trust-json.js";

export const MACHINE_TRUST_SCHEMA = "ananta.meet-machine-trust.v1";
export const MACHINE_GRANT_AUDIENCES = Object.freeze(["ananta-meet-machine-v1", "ananta-meet-machine-v2"]);
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const KID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const fail = () => { throw new Error("machine_trust_profile_invalid"); };
const identifier = value => typeof value === "string" && ID.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000;

function closed(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) fail();
}

function publicKey(value) {
  closed(value, ["kid", "x", "notBefore", "notAfter"]);
  if (typeof value.kid !== "string" || !KID.test(value.kid)
    || typeof value.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.x)
    || Buffer.from(value.x, "base64url").toString("base64url") !== value.x
    || !time(value.notBefore) || !time(value.notAfter) || value.notAfter <= value.notBefore) fail();
  return Object.freeze({ ...value });
}

function scope(value) {
  closed(value, ["subject", "tenantId", "projectId", "capabilities"]);
  if (![value.subject, value.tenantId, value.projectId].every(identifier) || !Array.isArray(value.capabilities)) fail();
  return Object.freeze({ ...value, capabilities: machineCapabilityCeiling(value.capabilities) });
}

/** Immutable, public operator policy; parsing alone never authorizes a session. */
export function parseMachineTrustProfile(input) {
  try {
    const value = typeof input === "string" ? parseMachineTrustJson(input) : input;
    closed(value, ["schema", "revision", "issuer", "audiences", "keys", "scopes"]);
    const url = new URL(value.issuer);
    if (value.schema !== MACHINE_TRUST_SCHEMA || !Number.isSafeInteger(value.revision) || value.revision < 1
      || typeof value.issuer !== "string" || value.issuer.length > 255 || url.protocol !== "https:"
      || url.origin !== value.issuer || url.username || url.password
      || !Array.isArray(value.audiences) || !value.audiences.length || value.audiences.length > 2
      || new Set(value.audiences).size !== value.audiences.length
      || value.audiences.some(aud => !MACHINE_GRANT_AUDIENCES.includes(aud))
      || !Array.isArray(value.keys) || !value.keys.length || value.keys.length > 4
      || !Array.isArray(value.scopes) || value.scopes.length > 128) fail();
    const keys = value.keys.map(publicKey), scopes = value.scopes.map(scope);
    if (new Set(keys.map(key => key.kid)).size !== keys.length || new Set(keys.map(key => key.x)).size !== keys.length
      || new Set(scopes.map(row => JSON.stringify([row.subject, row.tenantId, row.projectId]))).size !== scopes.length) fail();
    return Object.freeze({ ...value, audiences: Object.freeze([...value.audiences]),
      keys: Object.freeze(keys), scopes: Object.freeze(scopes) });
  } catch { fail(); }
}

export function machineTrustScopeAllows(profile, payload, capabilities) {
  return profile.scopes.some(row => row.subject === payload.sub && row.tenantId === payload.tenantId
    && row.projectId === payload.projectId && capabilities.every(cap => row.capabilities.includes(cap)));
}
