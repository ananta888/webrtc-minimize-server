import { SFRAME_BASE_KEY_BYTES } from "./sframe-codec";

export const MEDIA_E2EE_CIPHER_SUITE = "AES_128_GCM_SHA256_128" as const;

const TRACK_ID = /^[A-Za-z0-9_={}:-]{1,128}$/;
const PEER_ID = /^[a-f0-9]{16}$/;
const KEY_ID = /^[a-f0-9]{16}$/;
const BASE_KEY = /^[A-Za-z0-9_-]{22}$/;

export interface MediaKeyMessage {
  readonly version: 1;
  readonly type: "media-key";
  readonly publicationId: string;
  readonly senderPeerId: string;
  readonly membershipEpoch: number;
  readonly keyId: string;
  readonly cipherSuite: typeof MEDIA_E2EE_CIPHER_SUITE;
  readonly baseKey: string;
}

export interface MediaKeyAckMessage {
  readonly version: 1;
  readonly type: "media-key-ack";
  readonly publicationId: string;
  readonly senderPeerId: string;
  readonly membershipEpoch: number;
  readonly keyId: string;
}

export type MediaE2eeMessage = MediaKeyMessage | MediaKeyAckMessage;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array | null {
  if (!BASE_KEY.test(value)) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const result = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return result.length === SFRAME_BASE_KEY_BYTES ? result : null;
  } catch {
    return null;
  }
}

export function createMediaKeyMessage(input: Readonly<{
  publicationId: string;
  senderPeerId: string;
  membershipEpoch: number;
  keyId: string;
  baseKey: Uint8Array;
}>): MediaKeyMessage {
  if (!TRACK_ID.test(input.publicationId) || !PEER_ID.test(input.senderPeerId)
    || !Number.isSafeInteger(input.membershipEpoch) || input.membershipEpoch < 1
    || !KEY_ID.test(input.keyId) || input.baseKey.length !== SFRAME_BASE_KEY_BYTES) {
    throw new Error("invalid_media_key");
  }
  return Object.freeze({
    version: 1,
    type: "media-key",
    publicationId: input.publicationId,
    senderPeerId: input.senderPeerId,
    membershipEpoch: input.membershipEpoch,
    keyId: input.keyId,
    cipherSuite: MEDIA_E2EE_CIPHER_SUITE,
    baseKey: encode(input.baseKey),
  });
}

export function createMediaKeyAck(message: MediaKeyMessage): MediaKeyAckMessage {
  return Object.freeze({
    version: 1,
    type: "media-key-ack",
    publicationId: message.publicationId,
    senderPeerId: message.senderPeerId,
    membershipEpoch: message.membershipEpoch,
    keyId: message.keyId,
  });
}

export function parseMediaE2eeMessage(raw: unknown): MediaE2eeMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value["type"] === "media-key") {
    if (!exactKeys(value, [
      "version", "type", "publicationId", "senderPeerId", "membershipEpoch", "keyId", "cipherSuite", "baseKey",
    ]) || value["version"] !== 1 || !TRACK_ID.test(String(value["publicationId"] || ""))
      || !PEER_ID.test(String(value["senderPeerId"] || ""))
      || !Number.isSafeInteger(value["membershipEpoch"]) || Number(value["membershipEpoch"]) < 1
      || !KEY_ID.test(String(value["keyId"] || ""))
      || value["cipherSuite"] !== MEDIA_E2EE_CIPHER_SUITE) return null;
    const decoded = decode(String(value["baseKey"] || ""));
    if (!decoded) return null;
    decoded.fill(0);
    return Object.freeze(value as unknown as MediaKeyMessage);
  }
  if (value["type"] === "media-key-ack") {
    if (!exactKeys(value, ["version", "type", "publicationId", "senderPeerId", "membershipEpoch", "keyId"])
      || value["version"] !== 1 || !TRACK_ID.test(String(value["publicationId"] || ""))
      || !PEER_ID.test(String(value["senderPeerId"] || ""))
      || !Number.isSafeInteger(value["membershipEpoch"]) || Number(value["membershipEpoch"]) < 1
      || !KEY_ID.test(String(value["keyId"] || ""))) return null;
    return Object.freeze(value as unknown as MediaKeyAckMessage);
  }
  return null;
}

export function decodeMediaBaseKey(message: MediaKeyMessage): Uint8Array {
  const key = decode(message.baseKey);
  if (!key) throw new Error("invalid_media_key");
  return key;
}

export function keyIdToBigInt(keyId: string): bigint {
  if (!KEY_ID.test(keyId)) throw new Error("invalid_media_key_id");
  return BigInt(`0x${keyId}`);
}

export function randomMediaKey(): { readonly keyId: string; readonly baseKey: Uint8Array } {
  const keyId = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { keyId, baseKey: crypto.getRandomValues(new Uint8Array(SFRAME_BASE_KEY_BYTES)) };
}
