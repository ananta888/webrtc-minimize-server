import { SFRAME_MEDIA_ENVELOPE } from "../webrtc/sframe-media-envelope";
import { parseTrustedDecryptConsent, TrustedDecryptConsent, TrustedDecryptKeyEnvelope } from "./trusted-decrypt-key-lifecycle";

export interface TrustedSourceLease {
  readonly version: 1; readonly type: "trusted-source-lease";
  readonly sourceLeaseId: string; readonly revision: number; readonly consent: TrustedDecryptConsent;
  readonly assignmentId: string; readonly writerLeaseId: string; readonly fencingRevision: number;
  readonly publisherPeerId: string; readonly publisherDeviceRef: string;
  readonly publicationId: string; readonly publicationEpoch: number;
  readonly codec: "video/vp8" | "audio/opus"; readonly frameEnvelope: typeof SFRAME_MEDIA_ENVELOPE;
  readonly issuedAt: number; readonly expiresAt: number;
}
export interface TrustedSourceSignal {
  readonly version: 1; readonly type: "trusted-source-publisher-signal" | "trusted-source-agent-signal";
  readonly sourceLeaseId: string; readonly consentId: string; readonly assignmentId: string; readonly fencingRevision: number;
  readonly negotiationRevision: number; readonly sequence: number;
  readonly packagerId?: string; readonly packagerDeviceRef?: string;
  readonly description?: Readonly<RTCSessionDescriptionInit>; readonly candidate?: Readonly<RTCIceCandidateInit> | null;
}
const leaseFields = ["version", "type", "sourceLeaseId", "revision", "consent", "assignmentId", "writerLeaseId", "fencingRevision",
  "publisherPeerId", "publisherDeviceRef", "publicationId", "publicationEpoch", "codec", "frameEnvelope", "issuedAt", "expiresAt"];
const signalFields = ["version", "type", "sourceLeaseId", "consentId", "assignmentId", "fencingRevision", "negotiationRevision", "sequence"];
export function sourceFail(): never { throw new Error("trusted_source_rejected"); }
const ref = (value: unknown, prefix: string) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`).test(value);
const positive = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const exact = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => record(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const size = (value: string) => new TextEncoder().encode(value).byteLength;
export function sourceWireSize(value: unknown, max: number): boolean {
  try { const raw = JSON.stringify(value); return typeof raw === "string" && raw.length <= max && size(raw) <= max; } catch { return false; }
}

export function parseTrustedSourceChannel(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length > 8192 || size(raw) > 8192) return sourceFail();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return sourceFail(); }
  // JSON.parse validates syntax; this bounded token walk additionally rejects
  // duplicate (including escaped-equivalent) property names before use.
  const objects: (Set<string> | null)[] = [];
  for (const token of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/g)) {
    if (token[0] === "{") objects.push(new Set());
    else if (token[0] === "[") objects.push(null);
    else if (token[0] === "}" || token[0] === "]") objects.pop();
    else if (raw.slice(token.index + token[0].length).trimStart().startsWith(":")) {
      const keys = objects[objects.length-1], key = JSON.parse(token[0]) as string;
      if (!keys || keys.has(key)) return sourceFail();
      keys.add(key);
    }
  }
  return value;
}

export function parseTrustedSourceLease(raw: unknown, now = Date.now()): TrustedSourceLease {
  if (!exact(raw, leaseFields) || !sourceWireSize(raw, 8192)) return sourceFail();
  const consent = parseTrustedDecryptConsent(raw["consent"], now);
  if (!positive(consent.grantedAt) || consent.expiresAt <= consent.grantedAt) return sourceFail();
  const l = raw as unknown as TrustedSourceLease;
  const audio = ["microphone", "screen-audio"].includes(consent.sourceKind);
  if (l.version !== 1 || l.type !== "trusted-source-lease" || !ref(l.sourceLeaseId, "sls") || !positive(l.revision, 1024)
    || !ref(l.assignmentId, "asn") || !ref(l.writerLeaseId, "lea") || !positive(l.fencingRevision)
    || typeof l.publisherPeerId !== "string" || !/^[a-f0-9]{16}$/.test(l.publisherPeerId) || !ref(l.publisherDeviceRef, "dev")
    || typeof l.publicationId !== "string" || !/^[A-Za-z0-9_={}:-]{1,128}$/.test(l.publicationId) || !positive(l.publicationEpoch)
    || l.codec !== (audio ? "audio/opus" : "video/vp8") || l.frameEnvelope !== SFRAME_MEDIA_ENVELOPE
    || !positive(l.issuedAt) || !positive(l.expiresAt) || l.issuedAt > now+1000 || l.issuedAt < consent.grantedAt-5000
    || l.expiresAt <= now || l.expiresAt <= l.issuedAt || l.expiresAt-l.issuedAt > 5000
    || l.expiresAt > now+5000 || l.expiresAt > consent.expiresAt) return sourceFail();
  return Object.freeze({ ...l, consent });
}

export function sameTrustedSource(a: TrustedSourceLease, b: TrustedSourceLease): boolean {
  return leaseFields.filter(key => !["revision", "issuedAt", "expiresAt", "consent"].includes(key))
    .every(key => a[key as keyof TrustedSourceLease] === b[key as keyof TrustedSourceLease])
    && Object.keys(a.consent).every(key => a.consent[key as keyof TrustedDecryptConsent] === b.consent[key as keyof TrustedDecryptConsent]);
}

export function parseTrustedSourceSignal(raw: unknown, lease: TrustedSourceLease, incoming = true): TrustedSourceSignal {
  const kind = record(raw) && Object.hasOwn(raw, "description") ? "description" : "candidate";
  if (!exact(raw, [...signalFields, kind, ...(incoming ? ["packagerId", "packagerDeviceRef"] : [])])
    || !sourceWireSize(raw, incoming ? 32*1024 : 31*1024)) return sourceFail();
  const m = raw as unknown as TrustedSourceSignal;
  if (m.version !== 1 || m.type !== (incoming ? "trusted-source-agent-signal" : "trusted-source-publisher-signal")
    || m.sourceLeaseId !== lease.sourceLeaseId || m.consentId !== lease.consent.consentId
    || m.assignmentId !== lease.assignmentId || m.fencingRevision !== lease.fencingRevision
    || !positive(m.negotiationRevision, 16) || !positive(m.sequence, 129)
    || incoming && (m.packagerId !== lease.consent.granteePackagerRef || m.packagerDeviceRef !== lease.consent.granteeDeviceRef)) return sourceFail();
  if (kind === "description") {
    if (!exact(m.description, ["type", "sdp"]) || m.description.type !== (incoming ? "answer" : "offer")
      || typeof m.description.sdp !== "string" || !m.description.sdp || size(m.description.sdp) > 16384) return sourceFail();
    return Object.freeze({ ...m, description: Object.freeze({ ...m.description }) });
  }
  const c = m.candidate;
  if (c !== null && (!record(c) || Object.keys(c).some(key => !["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"].includes(key))
    || typeof c.candidate !== "string" || size(c.candidate) > 4096
    || (["sdpMid", "usernameFragment"] as const).some(key => Object.hasOwn(c, key) && c[key] !== null
      && (typeof c[key] !== "string" || size(c[key] as string) > 64))
    || Object.hasOwn(c, "sdpMLineIndex") && c.sdpMLineIndex !== null
      && (!Number.isSafeInteger(c.sdpMLineIndex) || Number(c.sdpMLineIndex) < 0 || Number(c.sdpMLineIndex) > 15))) return sourceFail();
  return Object.freeze({ ...m, candidate: c === null ? null : Object.freeze({ ...c }) });
}

export function verifyTrustedSourceAck(raw: unknown, lease: TrustedSourceLease, pending: TrustedDecryptKeyEnvelope, minimumRevision: number, now = Date.now()): void {
  if (!exact(raw, ["version", "type", "sourceLeaseId", "leaseRevision", "consentId", "agreementKeyId", "envelopeId", "keyId", "state", "expiresAt"])
    || !sourceWireSize(raw, 8192) || raw["version"] !== 1 || raw["type"] !== "trusted-source-key-ack" || raw["state"] !== "key-installed"
    || raw["sourceLeaseId"] !== lease.sourceLeaseId || raw["consentId"] !== lease.consent.consentId
    || raw["agreementKeyId"] !== pending.agreementKeyId || raw["envelopeId"] !== pending.envelopeId || raw["keyId"] !== pending.keyId
    || !positive(raw["leaseRevision"], lease.revision) || raw["leaseRevision"] < minimumRevision
    || !positive(raw["expiresAt"]) || raw["expiresAt"] <= now || raw["expiresAt"] > Math.min(lease.expiresAt, pending.expiresAt)) sourceFail();
}
