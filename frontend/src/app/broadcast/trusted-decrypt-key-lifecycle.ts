import { SFRAME_BASE_KEY_BYTES } from "../webrtc/sframe-codec";
import { SFRAME_MEDIA_ENVELOPE } from "../webrtc/sframe-media-envelope";

export type TrustedDecryptSourceKind = "microphone" | "camera" | "screen" | "screen-audio";

export interface TrustedDecryptConsent {
  readonly version: 1;
  readonly type: "trusted-decrypt-consent";
  readonly trigger: "user-action";
  readonly consentId: string;
  readonly tenantId: string;
  readonly roomId: string;
  readonly roomEpoch: number;
  readonly programId: string;
  readonly programEpoch: number;
  readonly grantorSubjectRef: string;
  readonly granteePackagerRef: string;
  readonly granteeDeviceRef: string;
  readonly sourceId: string;
  readonly sourceKind: TrustedDecryptSourceKind;
  readonly purpose: "broadcast-program";
  readonly status: "active";
  readonly grantedAt: number;
  readonly expiresAt: number;
}

export interface TrustedPackagerKeyAnnouncement {
  readonly version: 1;
  readonly type: "trusted-packager-key";
  readonly consentId: string;
  readonly granteePackagerRef: string;
  readonly granteeDeviceRef: string;
  readonly roomId: string;
  readonly roomEpoch: number;
  readonly programId: string;
  readonly programEpoch: number;
  readonly agreementKeyId: string;
  readonly publicKey: Readonly<JsonWebKey>;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface TrustedDecryptKeyEnvelope {
  readonly version: 1;
  readonly type: "trusted-decrypt-key";
  readonly envelopeId: string;
  readonly consentId: string;
  readonly tenantId: string;
  readonly roomId: string;
  readonly roomEpoch: number;
  readonly programId: string;
  readonly programEpoch: number;
  readonly grantorSubjectRef: string;
  readonly granteePackagerRef: string;
  readonly granteeDeviceRef: string;
  readonly sourceId: string;
  readonly sourceKind: TrustedDecryptSourceKind;
  readonly purpose: "broadcast-program";
  readonly keyId: string;
  readonly frameEnvelope: typeof SFRAME_MEDIA_ENVELOPE;
  readonly agreementKeyId: string;
  readonly senderPublicKey: Readonly<JsonWebKey>;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface TrustedDecryptConsentView {
  readonly consentId: string;
  readonly roomId: string;
  readonly roomEpoch: number;
  readonly programId: string;
  readonly programEpoch: number;
  readonly granteePackagerRef: string;
  readonly granteeDeviceRef: string;
  readonly sourceId: string;
  readonly sourceKind: TrustedDecryptSourceKind;
  readonly purpose: "broadcast-program";
  readonly expiresAt: number;
  readonly state: "waiting-key" | "active";
}

export interface TrustedDecryptAuditEvent {
  readonly eventVersion: 1;
  readonly eventType: "consent-authorized" | "key-installed" | "consent-revoked";
  readonly consentId: string;
  readonly roomId: string;
  readonly roomEpoch: number;
  readonly programId: string;
  readonly programEpoch: number;
  readonly grantorSubjectRef: string;
  readonly granteePackagerRef: string;
  readonly granteeDeviceRef: string;
  readonly sourceId: string;
  readonly sourceKind: TrustedDecryptSourceKind;
  readonly purpose: "broadcast-program";
  readonly occurredAt: number;
  readonly reasonCode: string;
}

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const P256_COORDINATE = /^[A-Za-z0-9_-]{43}$/;
const CONSENT_ID = /^cns_[A-Za-z0-9_-]{16,64}$/;
const TENANT_ID = /^tn_[A-Za-z0-9_-]{16,64}$/;
const SUBJECT_REF = /^sub_[A-Za-z0-9_-]{16,64}$/;
const PACKAGER_REF = /^pkr_[A-Za-z0-9_-]{16,64}$/;
const DEVICE_REF = /^dev_[A-Za-z0-9_-]{16,64}$/;
const PROGRAM_ID = /^prg_[A-Za-z0-9_-]{16,64}$/;
const SOURCE_ID = /^src_[A-Za-z0-9_-]{16,64}$/;
const ROOM_ID = /^[a-z0-9][a-z0-9-]{5,47}$/;
const KEY_ID = /^[a-f0-9]{16}$/;
const CONTEXT_ID = /^[A-Za-z0-9:_={}-]{1,196}$/;
const SOURCE_KINDS = new Set<TrustedDecryptSourceKind>(["microphone", "camera", "screen", "screen-audio"]);
const MAX_CLOCK_SKEW_MS = 5_000;
const MAX_CONSENT_TTL_MS = 10 * 60_000;
const MAX_KEY_TTL_MS = 60_000;
const MAX_WIRE_BYTES = 8 * 1024;

function fail(code: string): never {
  throw new Error(code);
}

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value: string, maximumBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(maximumBytes * 4 / 3) + 4) {
    fail("invalid_trusted_decrypt_encoding");
  }
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.length > maximumBytes) fail("invalid_trusted_decrypt_encoding");
    return bytes;
  } catch {
    return fail("invalid_trusted_decrypt_encoding");
  }
}

function bytes(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function validPublicJwk(value: unknown): value is Readonly<JsonWebKey> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return exact(key, ["kty", "crv", "x", "y", "ext", "key_ops"])
    && key["kty"] === "EC" && key["crv"] === "P-256" && key["ext"] === true
    && typeof key["x"] === "string" && P256_COORDINATE.test(key["x"])
    && typeof key["y"] === "string" && P256_COORDINATE.test(key["y"])
    && Array.isArray(key["key_ops"]) && key["key_ops"].length === 0;
}

const CONSENT_FIELDS = [
  "version", "type", "trigger", "consentId", "tenantId", "roomId", "roomEpoch", "programId",
  "programEpoch", "grantorSubjectRef", "granteePackagerRef", "granteeDeviceRef", "sourceId",
  "sourceKind", "purpose", "status", "grantedAt", "expiresAt",
] as const;

export function parseTrustedDecryptConsent(raw: unknown, now = Date.now()): TrustedDecryptConsent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_trusted_decrypt_consent");
  const value = raw as Record<string, unknown>;
  if (!exact(value, CONSENT_FIELDS) || value["version"] !== 1 || value["type"] !== "trusted-decrypt-consent"
    || value["trigger"] !== "user-action" || !CONSENT_ID.test(String(value["consentId"] || ""))
    || !TENANT_ID.test(String(value["tenantId"] || "")) || !ROOM_ID.test(String(value["roomId"] || ""))
    || !positive(value["roomEpoch"]) || !PROGRAM_ID.test(String(value["programId"] || ""))
    || !positive(value["programEpoch"]) || !SUBJECT_REF.test(String(value["grantorSubjectRef"] || ""))
    || !PACKAGER_REF.test(String(value["granteePackagerRef"] || ""))
    || !DEVICE_REF.test(String(value["granteeDeviceRef"] || ""))
    || !SOURCE_ID.test(String(value["sourceId"] || ""))
    || !SOURCE_KINDS.has(value["sourceKind"] as TrustedDecryptSourceKind)
    || value["purpose"] !== "broadcast-program" || value["status"] !== "active"
    || !Number.isSafeInteger(value["grantedAt"])
    || !Number.isSafeInteger(value["expiresAt"]) || Number(value["grantedAt"]) > now + MAX_CLOCK_SKEW_MS
    || Number(value["expiresAt"]) <= now
    || Number(value["expiresAt"]) - Number(value["grantedAt"]) > MAX_CONSENT_TTL_MS) {
    fail("invalid_trusted_decrypt_consent");
  }
  return Object.freeze({ ...value }) as unknown as TrustedDecryptConsent;
}

const ANNOUNCEMENT_FIELDS = [
  "version", "type", "consentId", "granteePackagerRef", "granteeDeviceRef", "roomId", "roomEpoch",
  "programId", "programEpoch", "agreementKeyId", "publicKey", "issuedAt", "expiresAt",
] as const;

export function parseTrustedPackagerKey(raw: unknown, consent: TrustedDecryptConsent, now = Date.now()): TrustedPackagerKeyAnnouncement {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_trusted_packager_key");
  const value = raw as Record<string, unknown>;
  if (!exact(value, ANNOUNCEMENT_FIELDS) || value["version"] !== 1 || value["type"] !== "trusted-packager-key"
    || value["consentId"] !== consent.consentId || value["granteePackagerRef"] !== consent.granteePackagerRef
    || value["granteeDeviceRef"] !== consent.granteeDeviceRef || value["roomId"] !== consent.roomId
    || value["roomEpoch"] !== consent.roomEpoch || value["programId"] !== consent.programId
    || value["programEpoch"] !== consent.programEpoch || !TOKEN.test(String(value["agreementKeyId"] || ""))
    || !validPublicJwk(value["publicKey"]) || !Number.isSafeInteger(value["issuedAt"])
    || !Number.isSafeInteger(value["expiresAt"]) || Number(value["issuedAt"]) > now + MAX_CLOCK_SKEW_MS
    || Number(value["expiresAt"]) <= now || Number(value["expiresAt"]) > consent.expiresAt) {
    fail("invalid_trusted_packager_key");
  }
  return Object.freeze({ ...value, publicKey: Object.freeze({ ...(value["publicKey"] as JsonWebKey) }) }) as unknown as TrustedPackagerKeyAnnouncement;
}

function aad(value: Omit<TrustedDecryptKeyEnvelope, "nonce" | "ciphertext" | "senderPublicKey">): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([
    value.version, value.type, value.envelopeId, value.consentId, value.tenantId, value.roomId,
    value.roomEpoch, value.programId, value.programEpoch, value.grantorSubjectRef,
    value.granteePackagerRef, value.granteeDeviceRef, value.sourceId, value.sourceKind, value.purpose,
    value.keyId, value.frameEnvelope, value.agreementKeyId, value.createdAt, value.expiresAt,
  ]));
}

async function importPublicKey(value: Readonly<JsonWebKey>): Promise<CryptoKey> {
  if (!validPublicJwk(value)) fail("invalid_trusted_decrypt_public_key");
  try {
    return await crypto.subtle.importKey("jwk", value, { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    return fail("invalid_trusted_decrypt_public_key");
  }
}

async function derive(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: publicKey }, privateKey,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

function randomToken(bytesLength = 18): string {
  return encode(crypto.getRandomValues(new Uint8Array(bytesLength)));
}

export async function sealTrustedDecryptKey(input: Readonly<{
  consent: TrustedDecryptConsent;
  announcement: TrustedPackagerKeyAnnouncement;
  keyId: string;
  baseKey: Uint8Array;
  now?: number;
}>): Promise<TrustedDecryptKeyEnvelope> {
  const now = input.now ?? Date.now();
  const consent = parseTrustedDecryptConsent(input.consent, now);
  const announcement = parseTrustedPackagerKey(input.announcement, consent, now);
  if (!KEY_ID.test(input.keyId) || input.baseKey.length !== SFRAME_BASE_KEY_BYTES) {
    fail("invalid_trusted_decrypt_source_key");
  }
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  const senderPublicKey = Object.freeze(await crypto.subtle.exportKey("jwk", pair.publicKey));
  const target = await importPublicKey(announcement.publicKey);
  const wrappingKey = await derive(pair.privateKey, target);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const header = Object.freeze({
    version: 1 as const,
    type: "trusted-decrypt-key" as const,
    envelopeId: randomToken(),
    consentId: consent.consentId,
    tenantId: consent.tenantId,
    roomId: consent.roomId,
    roomEpoch: consent.roomEpoch,
    programId: consent.programId,
    programEpoch: consent.programEpoch,
    grantorSubjectRef: consent.grantorSubjectRef,
    granteePackagerRef: consent.granteePackagerRef,
    granteeDeviceRef: consent.granteeDeviceRef,
    sourceId: consent.sourceId,
    sourceKind: consent.sourceKind,
    purpose: consent.purpose,
    keyId: input.keyId,
    frameEnvelope: SFRAME_MEDIA_ENVELOPE,
    agreementKeyId: announcement.agreementKeyId,
    createdAt: now,
    expiresAt: Math.min(consent.expiresAt, announcement.expiresAt, now + MAX_KEY_TTL_MS),
  });
  const plaintext = Uint8Array.from(input.baseKey);
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bytes(nonce), additionalData: bytes(aad(header)) }, wrappingKey, bytes(plaintext),
    );
    return Object.freeze({
      ...header,
      senderPublicKey,
      nonce: encode(nonce),
      ciphertext: encode(new Uint8Array(ciphertext)),
    });
  } finally {
    plaintext.fill(0);
  }
}

const ENVELOPE_FIELDS = [
  "version", "type", "envelopeId", "consentId", "tenantId", "roomId", "roomEpoch", "programId",
  "programEpoch", "grantorSubjectRef", "granteePackagerRef", "granteeDeviceRef", "sourceId",
  "sourceKind", "purpose", "keyId", "frameEnvelope", "agreementKeyId", "senderPublicKey",
  "createdAt", "expiresAt", "nonce", "ciphertext",
] as const;

export function parseTrustedDecryptKeyEnvelope(raw: unknown, consent: TrustedDecryptConsent, now = Date.now()): TrustedDecryptKeyEnvelope {
  let wireBytes = MAX_WIRE_BYTES + 1;
  try {
    wireBytes = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
  } catch {
    fail("invalid_trusted_decrypt_key");
  }
  if (wireBytes > MAX_WIRE_BYTES || !raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("invalid_trusted_decrypt_key");
  }
  const value = raw as Record<string, unknown>;
  if (!exact(value, ENVELOPE_FIELDS) || value["version"] !== 1 || value["type"] !== "trusted-decrypt-key"
    || !TOKEN.test(String(value["envelopeId"] || "")) || value["consentId"] !== consent.consentId
    || value["tenantId"] !== consent.tenantId || value["roomId"] !== consent.roomId
    || value["roomEpoch"] !== consent.roomEpoch || value["programId"] !== consent.programId
    || value["programEpoch"] !== consent.programEpoch || value["grantorSubjectRef"] !== consent.grantorSubjectRef
    || value["granteePackagerRef"] !== consent.granteePackagerRef
    || value["granteeDeviceRef"] !== consent.granteeDeviceRef || value["sourceId"] !== consent.sourceId
    || value["sourceKind"] !== consent.sourceKind || value["purpose"] !== consent.purpose
    || !KEY_ID.test(String(value["keyId"] || "")) || value["frameEnvelope"] !== SFRAME_MEDIA_ENVELOPE
    || !TOKEN.test(String(value["agreementKeyId"] || "")) || !validPublicJwk(value["senderPublicKey"])
    || !Number.isSafeInteger(value["createdAt"]) || !Number.isSafeInteger(value["expiresAt"])
    || Number(value["createdAt"]) > now + MAX_CLOCK_SKEW_MS || Number(value["expiresAt"]) <= now
    || Number(value["expiresAt"]) > consent.expiresAt
    || Number(value["expiresAt"]) - Number(value["createdAt"]) > MAX_KEY_TTL_MS
    || typeof value["nonce"] !== "string" || decode(value["nonce"], 12).length !== 12
    || typeof value["ciphertext"] !== "string" || decode(value["ciphertext"], 64).length !== 32) {
    fail("invalid_trusted_decrypt_key");
  }
  return Object.freeze({ ...value, senderPublicKey: Object.freeze({ ...(value["senderPublicKey"] as JsonWebKey) }) }) as unknown as TrustedDecryptKeyEnvelope;
}

interface VaultEntry {
  readonly consent: TrustedDecryptConsent;
  readonly agreementKeyId: string;
  readonly privateKey: CryptoKey;
  readonly announcement: TrustedPackagerKeyAnnouncement;
  readonly seen: Set<string>;
  readonly contexts: Set<string>;
  readonly expiryTimer: ReturnType<typeof setTimeout>;
}

export class TrustedDecryptKeyLifecycle {
  private readonly entries = new Map<string, VaultEntry>();
  private destroyed = false;

  constructor(
    private readonly clearContext: (contextId: string) => void,
    private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
      = (callback, delayMs) => setTimeout(callback, delayMs),
    private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
    private readonly audit: (event: TrustedDecryptAuditEvent) => void = () => undefined,
  ) {}

  private emit(entry: Pick<VaultEntry, "consent">, eventType: TrustedDecryptAuditEvent["eventType"],
    reasonCode: string, occurredAt = Date.now()): void {
    const consent = entry.consent;
    this.audit(Object.freeze({
      eventVersion: 1,
      eventType,
      consentId: consent.consentId,
      roomId: consent.roomId,
      roomEpoch: consent.roomEpoch,
      programId: consent.programId,
      programEpoch: consent.programEpoch,
      grantorSubjectRef: consent.grantorSubjectRef,
      granteePackagerRef: consent.granteePackagerRef,
      granteeDeviceRef: consent.granteeDeviceRef,
      sourceId: consent.sourceId,
      sourceKind: consent.sourceKind,
      purpose: consent.purpose,
      occurredAt,
      reasonCode,
    }));
  }

  async authorize(rawConsent: unknown, now = Date.now()): Promise<TrustedPackagerKeyAnnouncement> {
    if (this.destroyed) fail("trusted_decrypt_lifecycle_destroyed");
    const consent = parseTrustedDecryptConsent(rawConsent, now);
    if (this.entries.has(consent.consentId)) fail("trusted_decrypt_consent_already_authorized");
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
    const agreementKeyId = randomToken();
    const announcement = Object.freeze({
      version: 1 as const,
      type: "trusted-packager-key" as const,
      consentId: consent.consentId,
      granteePackagerRef: consent.granteePackagerRef,
      granteeDeviceRef: consent.granteeDeviceRef,
      roomId: consent.roomId,
      roomEpoch: consent.roomEpoch,
      programId: consent.programId,
      programEpoch: consent.programEpoch,
      agreementKeyId,
      publicKey: Object.freeze(await crypto.subtle.exportKey("jwk", pair.publicKey)),
      issuedAt: now,
      expiresAt: consent.expiresAt,
    });
    const expiryTimer = this.schedule(
      () => this.revoke(consent.consentId, "expired", consent.expiresAt),
      Math.max(0, consent.expiresAt - now),
    );
    this.entries.set(consent.consentId, {
      consent, agreementKeyId, privateKey: pair.privateKey, announcement, seen: new Set(), contexts: new Set(),
      expiryTimer,
    });
    this.emit({ consent }, "consent-authorized", "user-action", now);
    return announcement;
  }

  async install(
    rawEnvelope: unknown,
    rawConsent: unknown,
    contextId: string,
    installKey: (contextId: string, keyId: string, key: Uint8Array) => boolean,
    now = Date.now(),
  ): Promise<void> {
    if (this.destroyed || !CONTEXT_ID.test(contextId)) fail("invalid_trusted_decrypt_context");
    const consent = parseTrustedDecryptConsent(rawConsent, now);
    const entry = this.entries.get(consent.consentId);
    if (!entry || !CONSENT_FIELDS.every((field) => entry.consent[field] === consent[field])) {
      fail("inactive_trusted_decrypt_consent");
    }
    const envelope = parseTrustedDecryptKeyEnvelope(rawEnvelope, consent, now);
    if (envelope.agreementKeyId !== entry.agreementKeyId) fail("stale_trusted_decrypt_key");
    if (entry.seen.has(envelope.envelopeId)) fail("replayed_trusted_decrypt_key");
    entry.seen.add(envelope.envelopeId);
    let plaintext: Uint8Array | null = null;
    try {
      const senderPublicKey = await importPublicKey(envelope.senderPublicKey);
      const wrappingKey = await derive(entry.privateKey, senderPublicKey);
      const { senderPublicKey: _senderPublicKey, nonce: _nonce, ciphertext: _ciphertext, ...header } = envelope;
      plaintext = new Uint8Array(await crypto.subtle.decrypt({
        name: "AES-GCM",
        iv: bytes(decode(envelope.nonce, 12)),
        additionalData: bytes(aad(header as Omit<TrustedDecryptKeyEnvelope, "nonce" | "ciphertext" | "senderPublicKey">)),
      }, wrappingKey, bytes(decode(envelope.ciphertext, 64))));
      if (plaintext.length !== SFRAME_BASE_KEY_BYTES || !installKey(contextId, envelope.keyId, plaintext)) {
        fail("trusted_decrypt_key_install_failed");
      }
      entry.contexts.add(contextId);
      this.emit(entry, "key-installed", "source-key-installed", now);
    } catch (error) {
      entry.seen.delete(envelope.envelopeId);
      if (error instanceof Error && error.message === "trusted_decrypt_key_install_failed") throw error;
      fail("trusted_decrypt_key_authentication_failed");
    } finally {
      plaintext?.fill(0);
    }
  }

  revoke(consentId: string, reasonCode = "user-revoked", now = Date.now()): void {
    const entry = this.entries.get(consentId);
    if (!entry) return;
    for (const contextId of entry.contexts) this.clearContext(contextId);
    this.cancel(entry.expiryTimer);
    entry.contexts.clear();
    entry.seen.clear();
    this.entries.delete(consentId);
    this.emit(entry, "consent-revoked", reasonCode, now);
  }

  revokeProgram(programId: string): void {
    for (const [consentId, entry] of this.entries) {
      if (entry.consent.programId === programId) this.revoke(consentId, "packager-handoff");
    }
  }

  revokeRoom(roomId: string): void {
    for (const [consentId, entry] of this.entries) {
      if (entry.consent.roomId === roomId) this.revoke(consentId, "room-left");
    }
  }

  retainEpochs(roomId: string, roomEpoch: number, programId: string, programEpoch: number): void {
    for (const [consentId, entry] of this.entries) {
      if (entry.consent.roomId === roomId && (entry.consent.roomEpoch !== roomEpoch
        || entry.consent.programId !== programId || entry.consent.programEpoch !== programEpoch)) {
        this.revoke(consentId, "epoch-changed");
      }
    }
  }

  revokeExpired(now = Date.now()): void {
    for (const [consentId, entry] of this.entries) {
      if (entry.consent.expiresAt <= now) this.revoke(consentId, "expired", now);
    }
  }

  activeConsentIds(): readonly string[] {
    return Object.freeze([...this.entries.keys()].sort());
  }

  view(): readonly TrustedDecryptConsentView[] {
    return Object.freeze([...this.entries.values()].map(({ consent, contexts }) => Object.freeze({
      consentId: consent.consentId,
      roomId: consent.roomId,
      roomEpoch: consent.roomEpoch,
      programId: consent.programId,
      programEpoch: consent.programEpoch,
      granteePackagerRef: consent.granteePackagerRef,
      granteeDeviceRef: consent.granteeDeviceRef,
      sourceId: consent.sourceId,
      sourceKind: consent.sourceKind,
      purpose: consent.purpose,
      expiresAt: consent.expiresAt,
      state: contexts.size > 0 ? "active" as const : "waiting-key" as const,
    })).sort((left, right) => left.sourceId.localeCompare(right.sourceId)));
  }

  destroy(): void {
    for (const consentId of [...this.entries.keys()]) this.revoke(consentId, "destroyed");
    this.destroyed = true;
  }
}
