import crypto from "node:crypto";

const SAFE_COMPONENT = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const DEVICE_FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;

function digest(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(value).digest("base64url").slice(0, 32)}`;
}

function safeComponent(value, code) {
  const normalized = String(value || "");
  if (!SAFE_COMPONENT.test(normalized)) throw new TypeError(code);
  return normalized;
}

export function broadcastTenantRef(issuer) {
  const normalized = safeComponent(issuer, "invalid_broadcast_oidc_issuer");
  return digest("tn", `issuer\0${normalized}`);
}

export function broadcastSubjectRef(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new TypeError("invalid_broadcast_identity");
  }
  const issuer = safeComponent(identity.issuer, "invalid_broadcast_oidc_issuer");
  const subject = safeComponent(identity.subject, "invalid_broadcast_oidc_subject");
  return digest("sub", `subject\0${issuer}\0${subject}`);
}

export function broadcastDeviceRef(fingerprint) {
  if (!DEVICE_FINGERPRINT.test(String(fingerprint || ""))) {
    throw new TypeError("invalid_broadcast_device_fingerprint");
  }
  return digest("dev", `device\0${fingerprint}`);
}

export function oidcPrincipal(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new TypeError("invalid_broadcast_identity");
  }
  const issuer = safeComponent(identity.issuer, "invalid_broadcast_oidc_issuer");
  const subject = safeComponent(identity.subject, "invalid_broadcast_oidc_subject");
  return `${issuer}|${subject}`;
}
