import { createCipheriv, createDecipheriv, hkdfSync, timingSafeEqual } from "node:crypto";

export const MOQ_SECURE_OBJECTS_DRAFT = "draft-ietf-moq-secure-objects-01";
export const MOQ_SECURE_OBJECTS_CIPHER_SUITE = 0x0004;
export const MOQ_SECURE_OBJECTS_CIPHER_NAME = "AES_128_GCM_SHA256_128";
export const MAX_SECURE_OBJECT_PLAINTEXT_BYTES = 1024 * 1024;
export const MAX_SECURE_OBJECT_PROPERTIES_BYTES = 4096;
export const MAX_SECURE_OBJECTS_PER_KEY = 1_000_000;

const CONTEXT_FIELDS = new Set([
  "tenantId", "programId", "programEpoch", "audienceId", "namespace", "trackName", "deviceRef",
  "enabled", "maxObjectsPerKey",
]);
const KEY_FIELDS = new Set(["keyId", "trackBaseKey", "notBefore", "expiresAt"]);
const OBJECT_FIELDS = new Set([
  "groupId", "objectId", "priority", "payload", "encryptedProperties", "publicImmutableProperties",
]);
const ENVELOPE_FIELDS = new Set([
  "prototypeVersion", "draftVersion", "cipherSuite", "keyId", "namespace", "trackName",
  "groupId", "objectId", "priority", "immutableProperties", "ciphertext",
]);
const TENANT_ID = /^tn_[A-Za-z0-9_-]{16,64}$/;
const PROGRAM_ID = /^prg_[A-Za-z0-9_-]{16,64}$/;
const AUDIENCE_ID = /^aud_[A-Za-z0-9_-]{16,64}$/;
const DEVICE_REF = /^dev_[A-Za-z0-9_-]{16,64}$/;
const TRACK_NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const NAMESPACE = /^tn_[A-Za-z0-9_-]{16,64}\/prg_[A-Za-z0-9_-]{16,64}\/epoch\/[1-9][0-9]{0,15}$/;

export class MoqSecureObjectPrototypeError extends Error {
  constructor(code) {
    super(code);
    this.name = "MoqSecureObjectPrototypeError";
    this.code = code;
  }
}

function fail(code) {
  throw new MoqSecureObjectPrototypeError(code);
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((field) => !fields.has(field))) fail(code);
}

function bytes(value, max, code) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail(code);
  if (value.byteLength > max) fail(code);
  return Buffer.from(value);
}

export function encodeMoqVarint(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_073_741_823) fail("secure_object_varint_out_of_range");
  if (value < 64) return Buffer.from([value]);
  if (value < 16_384) {
    const output = Buffer.alloc(2);
    output.writeUInt16BE(value | 0x4000);
    return output;
  }
  const output = Buffer.alloc(4);
  output.writeUInt32BE(value + 0x80000000);
  return output;
}

function decodeMoqVarint(buffer, offset) {
  if (offset >= buffer.length) fail("invalid_secure_object_plaintext");
  const prefix = buffer[offset] >> 6;
  const length = 1 << prefix;
  if (length > 4 || offset + length > buffer.length) fail("invalid_secure_object_plaintext");
  if (length === 1) return { value: buffer[offset] & 0x3f, next: offset + 1 };
  if (length === 2) return { value: buffer.readUInt16BE(offset) & 0x3fff, next: offset + 2 };
  return { value: buffer.readUInt32BE(offset) & 0x3fffffff, next: offset + 4 };
}

export function serializeMoqFullTrackName(namespace, trackName) {
  if (typeof namespace !== "string" || namespace.length < 1 || namespace.length > 240
    || !TRACK_NAME.test(trackName)) fail("invalid_secure_object_track");
  const tuples = namespace.split("/").map((part) => Buffer.from(part, "utf8"));
  if (tuples.length < 1 || tuples.length > 32 || tuples.some((part) => part.length < 1 || part.length > 255)) {
    fail("invalid_secure_object_track");
  }
  const encodedTrack = Buffer.from(trackName, "utf8");
  return Buffer.concat([
    encodeMoqVarint(tuples.length),
    ...tuples.flatMap((part) => [encodeMoqVarint(part.length), part]),
    encodeMoqVarint(encodedTrack.length),
    encodedTrack,
  ]);
}

function uint64(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_secure_object_group_id");
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(BigInt(value));
  return output;
}

function uint32(value, code = "invalid_secure_object_object_id") {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) fail(code);
  const output = Buffer.alloc(4);
  output.writeUInt32BE(value);
  return output;
}

function uint16(value) {
  const output = Buffer.alloc(2);
  output.writeUInt16BE(value);
  return output;
}

function keyIdBytes(keyId) {
  if (!Number.isSafeInteger(keyId) || keyId < 1) fail("invalid_secure_object_key_id");
  return uint64(keyId);
}

function immutableProperties(keyId, extra) {
  const publicBytes = bytes(extra, MAX_SECURE_OBJECT_PROPERTIES_BYTES, "secure_object_properties_too_large");
  const encodedKey = keyIdBytes(keyId);
  return Buffer.concat([encodeMoqVarint(0x2), encodeMoqVarint(encodedKey.length), encodedKey, publicBytes]);
}

function deriveKeyAndSalt(trackBaseKey, keyId, fullTrackName) {
  const suffix = Buffer.concat([fullTrackName, uint16(MOQ_SECURE_OBJECTS_CIPHER_SUITE), keyIdBytes(keyId)]);
  const key = Buffer.from(hkdfSync("sha256", trackBaseKey, Buffer.alloc(0), Buffer.concat([
    Buffer.from("MOQ 1.0 Secure Objects Secret key ", "utf8"), suffix,
  ]), 16));
  const salt = Buffer.from(hkdfSync("sha256", trackBaseKey, Buffer.alloc(0), Buffer.concat([
    Buffer.from("MOQ 1.0 Secret salt ", "utf8"), suffix,
  ]), 12));
  return { key, salt };
}

function nonce(salt, groupId, objectId) {
  const counter = Buffer.concat([uint64(groupId), uint32(objectId)]);
  const output = Buffer.alloc(12);
  for (let index = 0; index < output.length; index += 1) output[index] = salt[index] ^ counter[index];
  return output;
}

function aad(groupId, objectId, priority, immutable) {
  if (!Number.isInteger(priority) || priority < 0 || priority > 255) fail("invalid_secure_object_priority");
  return Buffer.concat([uint64(groupId), uint32(objectId), Buffer.from([priority]), immutable]);
}

function plaintext(payload, encryptedProperties) {
  const content = bytes(payload, MAX_SECURE_OBJECT_PLAINTEXT_BYTES, "secure_object_payload_too_large");
  const properties = bytes(encryptedProperties, MAX_SECURE_OBJECT_PROPERTIES_BYTES,
    "secure_object_properties_too_large");
  const suffix = properties.length === 0 ? Buffer.alloc(0) : Buffer.concat([
    uint16(0x000a), encodeMoqVarint(properties.length), properties,
  ]);
  const output = Buffer.concat([encodeMoqVarint(content.length), content, suffix]);
  if (output.length > MAX_SECURE_OBJECT_PLAINTEXT_BYTES + MAX_SECURE_OBJECT_PROPERTIES_BYTES + 16) {
    fail("secure_object_plaintext_too_large");
  }
  return output;
}

function parsePlaintext(value) {
  const payloadLength = decodeMoqVarint(value, 0);
  const payloadEnd = payloadLength.next + payloadLength.value;
  if (payloadEnd > value.length) fail("invalid_secure_object_plaintext");
  const payload = Buffer.from(value.subarray(payloadLength.next, payloadEnd));
  if (payloadEnd === value.length) return { payload, encryptedProperties: Buffer.alloc(0) };
  if (payloadEnd + 2 > value.length || value.readUInt16BE(payloadEnd) !== 0x000a) {
    fail("invalid_secure_object_plaintext");
  }
  const propertyLength = decodeMoqVarint(value, payloadEnd + 2);
  if (propertyLength.next + propertyLength.value !== value.length) fail("invalid_secure_object_plaintext");
  return {
    payload,
    encryptedProperties: Buffer.from(value.subarray(propertyLength.next)),
  };
}

function cloneEnvelope(value) {
  exactObject(value, ENVELOPE_FIELDS, "invalid_secure_object_envelope");
  if (value.prototypeVersion !== 1 || value.draftVersion !== MOQ_SECURE_OBJECTS_DRAFT
    || value.cipherSuite !== MOQ_SECURE_OBJECTS_CIPHER_SUITE || !Number.isSafeInteger(value.keyId)
    || value.keyId < 1 || !NAMESPACE.test(value.namespace || "") || !TRACK_NAME.test(value.trackName || "")
    || !Number.isSafeInteger(value.groupId) || value.groupId < 0
    || !Number.isInteger(value.objectId) || value.objectId < 0 || value.objectId > 0xffffffff
    || !Number.isInteger(value.priority) || value.priority < 0 || value.priority > 255) {
    fail("invalid_secure_object_envelope");
  }
  const immutable = bytes(value.immutableProperties, MAX_SECURE_OBJECT_PROPERTIES_BYTES + 16,
    "invalid_secure_object_envelope");
  const ciphertext = bytes(value.ciphertext, MAX_SECURE_OBJECT_PLAINTEXT_BYTES
    + MAX_SECURE_OBJECT_PROPERTIES_BYTES + 32, "invalid_secure_object_envelope");
  if (immutable.length < 10 || ciphertext.length < 16) fail("invalid_secure_object_envelope");
  return Object.freeze({
    prototypeVersion: value.prototypeVersion,
    draftVersion: value.draftVersion,
    cipherSuite: value.cipherSuite,
    keyId: value.keyId,
    namespace: value.namespace,
    trackName: value.trackName,
    groupId: value.groupId,
    objectId: value.objectId,
    priority: value.priority,
    immutableProperties: immutable,
    ciphertext,
  });
}

export function relaySecureMoqObject(envelope) {
  return cloneEnvelope(envelope);
}

export class MoqSecureObjectsPrototype {
  #context;
  #keys = new Map();
  #activeKeyId = null;
  #sealedIds = new Set();
  #openedIds = new Set();
  #destroyed = false;
  #clock;

  constructor(context, clock = Date.now) {
    exactObject(context, CONTEXT_FIELDS, "invalid_secure_object_context");
    if (!TENANT_ID.test(context.tenantId || "") || !PROGRAM_ID.test(context.programId || "")
      || !AUDIENCE_ID.test(context.audienceId || "") || !DEVICE_REF.test(context.deviceRef || "")
      || !Number.isSafeInteger(context.programEpoch) || context.programEpoch < 1
      || context.namespace !== `${context.tenantId}/${context.programId}/epoch/${context.programEpoch}`
      || !TRACK_NAME.test(context.trackName || "") || typeof context.enabled !== "boolean"
      || !Number.isInteger(context.maxObjectsPerKey) || context.maxObjectsPerKey < 1
      || context.maxObjectsPerKey > MAX_SECURE_OBJECTS_PER_KEY || typeof clock !== "function") {
      fail("invalid_secure_object_context");
    }
    this.#context = Object.freeze({ ...context });
    this.#clock = clock;
  }

  addKey(record) {
    this.#assertUsable();
    exactObject(record, KEY_FIELDS, "invalid_secure_object_key");
    if (!Number.isSafeInteger(record.keyId) || record.keyId < 1
      || !Number.isSafeInteger(record.notBefore) || !Number.isSafeInteger(record.expiresAt)
      || record.notBefore >= record.expiresAt || this.#keys.has(record.keyId)) fail("invalid_secure_object_key");
    const key = bytes(record.trackBaseKey, 64, "invalid_secure_object_key");
    if (key.length < 16) fail("invalid_secure_object_key");
    this.#keys.set(record.keyId, {
      key, notBefore: record.notBefore, expiresAt: record.expiresAt, invocations: 0, revoked: false,
    });
  }

  activateKey(keyId) {
    this.#assertUsable();
    const record = this.#key(keyId, this.#clock());
    if (record.invocations >= this.#context.maxObjectsPerKey) fail("secure_object_key_limit_reached");
    this.#activeKeyId = keyId;
  }

  revokeKey(keyId) {
    const record = this.#keys.get(keyId);
    if (!record) return false;
    record.revoked = true;
    record.key.fill(0);
    if (this.#activeKeyId === keyId) this.#activeKeyId = null;
    return true;
  }

  loseDevice(deviceRef) {
    if (deviceRef !== this.#context.deviceRef) return false;
    this.destroy();
    return true;
  }

  seal(rawObject) {
    this.#assertUsable();
    if (!this.#context.enabled) fail("secure_objects_disabled");
    exactObject(rawObject, OBJECT_FIELDS, "invalid_secure_object_input");
    if (this.#activeKeyId === null) fail("secure_object_key_unavailable");
    const now = this.#clock();
    const record = this.#key(this.#activeKeyId, now);
    if (record.invocations >= this.#context.maxObjectsPerKey) fail("secure_object_key_limit_reached");
    const objectKey = `${this.#activeKeyId}:${rawObject.groupId}:${rawObject.objectId}`;
    if (this.#sealedIds.has(objectKey)) fail("secure_object_nonce_reuse");
    const immutable = immutableProperties(this.#activeKeyId,
      rawObject.publicImmutableProperties || Buffer.alloc(0));
    const fullTrackName = serializeMoqFullTrackName(this.#context.namespace, this.#context.trackName);
    const derived = deriveKeyAndSalt(record.key, this.#activeKeyId, fullTrackName);
    try {
      const cipher = createCipheriv("aes-128-gcm", derived.key,
        nonce(derived.salt, rawObject.groupId, rawObject.objectId), { authTagLength: 16 });
      cipher.setAAD(aad(rawObject.groupId, rawObject.objectId, rawObject.priority, immutable));
      const encrypted = Buffer.concat([
        cipher.update(plaintext(rawObject.payload, rawObject.encryptedProperties || Buffer.alloc(0))),
        cipher.final(),
      ]);
      const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]);
      this.#sealedIds.add(objectKey);
      record.invocations += 1;
      return cloneEnvelope({
        prototypeVersion: 1,
        draftVersion: MOQ_SECURE_OBJECTS_DRAFT,
        cipherSuite: MOQ_SECURE_OBJECTS_CIPHER_SUITE,
        keyId: this.#activeKeyId,
        namespace: this.#context.namespace,
        trackName: this.#context.trackName,
        groupId: rawObject.groupId,
        objectId: rawObject.objectId,
        priority: rawObject.priority,
        immutableProperties: immutable,
        ciphertext,
      });
    } finally {
      derived.key.fill(0);
      derived.salt.fill(0);
    }
  }

  open(rawEnvelope) {
    this.#assertUsable();
    if (!this.#context.enabled) fail("secure_objects_disabled");
    const envelope = cloneEnvelope(rawEnvelope);
    if (envelope.namespace !== this.#context.namespace || envelope.trackName !== this.#context.trackName) {
      fail("secure_object_auth_failed");
    }
    const replayKey = `${envelope.keyId}:${envelope.groupId}:${envelope.objectId}`;
    if (this.#openedIds.has(replayKey)) fail("secure_object_replay");
    const record = this.#key(envelope.keyId, this.#clock());
    const expectedKeyPrefix = immutableProperties(envelope.keyId, Buffer.alloc(0));
    if (envelope.immutableProperties.length < expectedKeyPrefix.length
      || !timingSafeEqual(envelope.immutableProperties.subarray(0, expectedKeyPrefix.length), expectedKeyPrefix)) {
      fail("secure_object_auth_failed");
    }
    if (envelope.ciphertext.length < 16) fail("secure_object_auth_failed");
    const fullTrackName = serializeMoqFullTrackName(envelope.namespace, envelope.trackName);
    const derived = deriveKeyAndSalt(record.key, envelope.keyId, fullTrackName);
    try {
      const ciphertext = envelope.ciphertext.subarray(0, -16);
      const tag = envelope.ciphertext.subarray(-16);
      const decipher = createDecipheriv("aes-128-gcm", derived.key,
        nonce(derived.salt, envelope.groupId, envelope.objectId), { authTagLength: 16 });
      decipher.setAAD(aad(envelope.groupId, envelope.objectId, envelope.priority,
        envelope.immutableProperties));
      decipher.setAuthTag(tag);
      let opened;
      try {
        opened = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        fail("secure_object_auth_failed");
      }
      const parsed = parsePlaintext(opened);
      this.#openedIds.add(replayKey);
      return Object.freeze({
        payload: Buffer.from(parsed.payload),
        encryptedProperties: Buffer.from(parsed.encryptedProperties),
      });
    } finally {
      derived.key.fill(0);
      derived.salt.fill(0);
    }
  }

  destroy() {
    if (this.#destroyed) return;
    for (const record of this.#keys.values()) record.key.fill(0);
    this.#keys.clear();
    this.#sealedIds.clear();
    this.#openedIds.clear();
    this.#activeKeyId = null;
    this.#destroyed = true;
  }

  #key(keyId, now) {
    const record = this.#keys.get(keyId);
    if (!record || record.revoked || now < record.notBefore || now >= record.expiresAt) {
      fail("secure_object_key_unavailable");
    }
    return record;
  }

  #assertUsable() {
    if (this.#destroyed) fail("secure_object_context_destroyed");
  }
}
