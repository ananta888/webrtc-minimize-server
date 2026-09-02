import { MEDIA_E2EE_CIPHER_SUITE, MEDIA_E2EE_PROTOCOL_VERSION } from "./media-e2ee-protocol";
import { SFRAME_BASE_KEY_BYTES } from "./sframe-codec";
import { SFRAME_MEDIA_ENVELOPE } from "./sframe-media-envelope";

const TRACK_ID = /^[A-Za-z0-9_={}:-]{1,128}$/;
const PEER_ID = /^[a-f0-9]{16}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const KEY_ID = /^[a-f0-9]{16}$/;
const BASE_KEY = /^[A-Za-z0-9_-]{22}$/;

export interface MediaAgentKeyMessage {
  readonly version: typeof MEDIA_E2EE_PROTOCOL_VERSION;
  readonly type: "media-agent-key";
  readonly publicationId: string;
  readonly senderPeerId: string;
  readonly agentId: string;
  readonly membershipEpoch: number;
  readonly routeEpoch: number;
  readonly keyId: string;
  readonly cipherSuite: typeof MEDIA_E2EE_CIPHER_SUITE;
  readonly frameEnvelope: typeof SFRAME_MEDIA_ENVELOPE;
  readonly baseKey: string;
}

export interface MediaAgentKeyAckMessage {
  readonly version: typeof MEDIA_E2EE_PROTOCOL_VERSION;
  readonly type: "media-agent-key-ack";
  readonly publicationId: string;
  readonly senderPeerId: string;
  readonly agentId: string;
  readonly membershipEpoch: number;
  readonly routeEpoch: number;
  readonly keyId: string;
  readonly frameEnvelope: typeof SFRAME_MEDIA_ENVELOPE;
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
  } catch { return null; }
}

function validBase(value: Record<string, unknown>): boolean {
  return value["version"] === MEDIA_E2EE_PROTOCOL_VERSION
    && TRACK_ID.test(String(value["publicationId"] || ""))
    && PEER_ID.test(String(value["senderPeerId"] || "")) && AGENT_ID.test(String(value["agentId"] || ""))
    && Number.isSafeInteger(value["membershipEpoch"]) && Number(value["membershipEpoch"]) >= 1
    && Number.isSafeInteger(value["routeEpoch"]) && Number(value["routeEpoch"]) >= 1
    && KEY_ID.test(String(value["keyId"] || ""));
}

export function createMediaAgentKeyMessage(input: Readonly<{
  publicationId: string;
  senderPeerId: string;
  agentId: string;
  membershipEpoch: number;
  routeEpoch: number;
  keyId: string;
  baseKey: Uint8Array;
}>): MediaAgentKeyMessage {
  const candidate: Record<string, unknown> = { version: MEDIA_E2EE_PROTOCOL_VERSION, ...input };
  if (!validBase(candidate) || input.baseKey.length !== SFRAME_BASE_KEY_BYTES) throw new Error("invalid_media_agent_key");
  return Object.freeze({
    version: MEDIA_E2EE_PROTOCOL_VERSION,
    type: "media-agent-key",
    publicationId: input.publicationId,
    senderPeerId: input.senderPeerId,
    agentId: input.agentId,
    membershipEpoch: input.membershipEpoch,
    routeEpoch: input.routeEpoch,
    keyId: input.keyId,
    cipherSuite: MEDIA_E2EE_CIPHER_SUITE,
    frameEnvelope: SFRAME_MEDIA_ENVELOPE,
    baseKey: encode(input.baseKey),
  });
}

export function createMediaAgentKeyAck(message: MediaAgentKeyMessage): MediaAgentKeyAckMessage {
  return Object.freeze({
    version: MEDIA_E2EE_PROTOCOL_VERSION,
    type: "media-agent-key-ack",
    publicationId: message.publicationId,
    senderPeerId: message.senderPeerId,
    agentId: message.agentId,
    membershipEpoch: message.membershipEpoch,
    routeEpoch: message.routeEpoch,
    keyId: message.keyId,
    frameEnvelope: message.frameEnvelope,
  });
}

export function parseMediaAgentE2eeMessage(raw: unknown): MediaAgentKeyMessage | MediaAgentKeyAckMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!validBase(value)) return null;
  const baseFields = [
    "version", "type", "publicationId", "senderPeerId", "agentId", "membershipEpoch", "routeEpoch", "keyId",
    "frameEnvelope",
  ];
  if (value["frameEnvelope"] !== SFRAME_MEDIA_ENVELOPE) return null;
  if (value["type"] === "media-agent-key") {
    const fields = [...baseFields, "cipherSuite", "baseKey"];
    const decoded = decode(String(value["baseKey"] || ""));
    if (Object.keys(value).length !== fields.length || !fields.every((field) => Object.hasOwn(value, field))
      || value["cipherSuite"] !== MEDIA_E2EE_CIPHER_SUITE || !decoded) return null;
    decoded.fill(0);
    return Object.freeze(value as unknown as MediaAgentKeyMessage);
  }
  if (value["type"] === "media-agent-key-ack") {
    if (Object.keys(value).length !== baseFields.length || !baseFields.every((field) => Object.hasOwn(value, field))) return null;
    return Object.freeze(value as unknown as MediaAgentKeyAckMessage);
  }
  return null;
}

export function decodeMediaAgentBaseKey(message: MediaAgentKeyMessage): Uint8Array {
  const result = decode(message.baseKey);
  if (!result) throw new Error("invalid_media_agent_key");
  return result;
}
