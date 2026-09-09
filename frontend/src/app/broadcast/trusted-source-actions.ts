import { parseTrustedDecryptConsent, TrustedDecryptConsent, TrustedDecryptSourceKind } from "./trusted-decrypt-key-lifecycle";
import { sourceFail, sourceWireSize } from "./trusted-source-contract";

export interface OwnSourcePublication {
  readonly publicationId: string;
  readonly source: TrustedDecryptSourceKind;
  readonly publicationEpoch: number;
}
export interface SourcePublisherContext {
  readonly roomId: string; readonly peerId: string; readonly roomEpoch: number;
  readonly fingerprint: string; readonly identity: string;
}
export interface OwnSourcePublications {
  readonly publicationRevision: number;
  readonly publications: readonly OwnSourcePublication[];
}
const exact = (raw: unknown, fields: readonly string[]): raw is Record<string, unknown> => Boolean(raw
  && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === fields.length
  && fields.every(key => Object.hasOwn(raw, key)) && sourceWireSize(raw, 8192));
const positive = (raw: unknown) => Number.isSafeInteger(raw) && Number(raw) > 0;

export function samePublisherContext(a: SourcePublisherContext, b: SourcePublisherContext | null): boolean {
  return b !== null && a.roomId === b.roomId && a.peerId === b.peerId && a.roomEpoch === b.roomEpoch
    && a.fingerprint === b.fingerprint && a.identity === b.identity;
}

/** Server metadata only: neither this response nor its parser grants capture or sending. */
export function parseOwnSourcePublications(raw: unknown, context: SourcePublisherContext): OwnSourcePublications {
  if (!exact(raw, ["version", "type", "roomId", "peerId", "roomEpoch", "publicationRevision", "publications"])
    || raw["version"] !== 1 || raw["type"] !== "trusted-source-publications"
    || typeof raw["roomId"] !== "string" || !/^[a-z0-9][a-z0-9-]{5,47}$/.test(raw["roomId"])
    || typeof raw["peerId"] !== "string" || !/^[a-f0-9]{16}$/.test(raw["peerId"]) || !positive(raw["roomEpoch"])
    || raw["roomId"] !== context.roomId || raw["peerId"] !== context.peerId || raw["roomEpoch"] !== context.roomEpoch
    || !Number.isSafeInteger(raw["publicationRevision"]) || Number(raw["publicationRevision"]) < 0
    || !Array.isArray(raw["publications"]) || raw["publications"].length > 4) return sourceFail();
  const seen = new Set<string>(), kinds = new Set<string>();
  const publications = raw["publications"].map(value => {
    if (!exact(value, ["publicationId", "source", "publicationEpoch"])
      || typeof value["publicationId"] !== "string" || !/^[A-Za-z0-9_={}:-]{1,128}$/.test(value["publicationId"])
      || typeof value["source"] !== "string" || !["camera", "microphone", "screen", "screen-audio"].includes(value["source"])
      || !positive(value["publicationEpoch"]) || seen.has(value["publicationId"]) || kinds.has(value["source"])) return sourceFail();
    seen.add(value["publicationId"]); kinds.add(value["source"]);
    return Object.freeze({ publicationId: value["publicationId"], source: value["source"] as TrustedDecryptSourceKind,
      publicationEpoch: Number(value["publicationEpoch"]) });
  });
  return Object.freeze({ publicationRevision: Number(raw["publicationRevision"]), publications: Object.freeze(publications) });
}

export function parseSourceApproval(raw: unknown, now = Date.now()): { requestId: string; consent: TrustedDecryptConsent } {
  if (!exact(raw, ["version", "type", "requestId", "consent"]) || raw["version"] !== 1 || raw["type"] !== "trusted-source-approved"
    || typeof raw["requestId"] !== "string" || !/^bsr_[A-Za-z0-9_-]{24}$/.test(raw["requestId"])) return sourceFail();
  return Object.freeze({ requestId: raw["requestId"], consent: parseTrustedDecryptConsent(raw["consent"], now) });
}

export function parseSourceStop(raw: unknown): Readonly<Record<string, unknown>> {
  if (!exact(raw, ["version", "type", "sourceLeaseId", "leaseRevision", "consentId", "assignmentId", "fencingRevision", "expiresAt", "reasonCode"])
    || raw["version"] !== 1 || raw["type"] !== "trusted-source-publisher-stop"
    || typeof raw["sourceLeaseId"] !== "string" || !/^sls_[A-Za-z0-9_-]{16,64}$/.test(raw["sourceLeaseId"])
    || typeof raw["consentId"] !== "string" || !/^cns_[A-Za-z0-9_-]{16,64}$/.test(raw["consentId"])
    || typeof raw["assignmentId"] !== "string" || !/^asn_[A-Za-z0-9_-]{16,64}$/.test(raw["assignmentId"])
    || !positive(raw["leaseRevision"]) || Number(raw["leaseRevision"]) > 1024
    || !positive(raw["fencingRevision"]) || !positive(raw["expiresAt"])
    || typeof raw["reasonCode"] !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(raw["reasonCode"])) return sourceFail();
  return Object.freeze({ ...raw });
}

/** Public references only. Browser claims are context pins, never server authority. */
export async function sourceIdentityReferences(issuer: string, subject: string, fingerprint: string) {
  if (![issuer, subject].every(value => typeof value === "string" && /^[^\u0000-\u001f\u007f]{1,1024}$/.test(value))
    || !/^[A-Za-z0-9_-]{43}$/.test(fingerprint)) return sourceFail();
  const ref = async (prefix: string, input: string) => {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
    return prefix + btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "").slice(0, 32);
  };
  const [tenantId, subjectRef, deviceRef] = await Promise.all([
    ref("tn_", "issuer\0" + issuer), ref("sub_", "subject\0" + issuer + "\0" + subject), ref("dev_", "device\0" + fingerprint),
  ]);
  return Object.freeze({ tenantId, subjectRef, deviceRef });
}
