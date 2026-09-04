import assert from "node:assert/strict";
import test from "node:test";

import {
  MOQ_SECURE_OBJECTS_CIPHER_NAME,
  MOQ_SECURE_OBJECTS_CIPHER_SUITE,
  MOQ_SECURE_OBJECTS_DRAFT,
  MoqSecureObjectPrototypeError,
  MoqSecureObjectsPrototype,
  encodeMoqVarint,
  relaySecureMoqObject,
  serializeMoqFullTrackName,
} from "../src/moq-secure-objects-prototype.js";

const NOW = 1_800_000_000_000;
const CONTEXT = Object.freeze({
  tenantId: "tn_aaaaaaaaaaaaaaaa",
  programId: "prg_bbbbbbbbbbbbbbbb",
  programEpoch: 7,
  audienceId: "aud_cccccccccccccccc",
  namespace: "tn_aaaaaaaaaaaaaaaa/prg_bbbbbbbbbbbbbbbb/epoch/7",
  trackName: "video-main",
  deviceRef: "dev_dddddddddddddddd",
  enabled: true,
  maxObjectsPerKey: 4,
});
const KEY_ONE = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const KEY_TWO = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");
const errorCode = (code) => (error) => error instanceof MoqSecureObjectPrototypeError && error.code === code;

function context(patch = {}) {
  return new MoqSecureObjectsPrototype({ ...CONTEXT, ...patch }, () => NOW);
}

function install(instance, keyId = 1, trackBaseKey = KEY_ONE) {
  instance.addKey({ keyId, trackBaseKey, notBefore: NOW - 1_000, expiresAt: NOW + 60_000 });
  instance.activateKey(keyId);
}

function mediaObject(patch = {}) {
  return {
    groupId: 9,
    objectId: 3,
    priority: 32,
    payload: Buffer.from("private-frame-payload"),
    encryptedProperties: Buffer.from("private-caption-property"),
    publicImmutableProperties: Buffer.from([0x41, 0x42]),
    ...patch,
  };
}

test("prototype pins draft-01 and its mandatory AES-128-GCM suite", () => {
  assert.equal(MOQ_SECURE_OBJECTS_DRAFT, "draft-ietf-moq-secure-objects-01");
  assert.equal(MOQ_SECURE_OBJECTS_CIPHER_SUITE, 0x0004);
  assert.equal(MOQ_SECURE_OBJECTS_CIPHER_NAME, "AES_128_GCM_SHA256_128");
  assert.deepEqual([...encodeMoqVarint(63)], [63]);
  assert.deepEqual([...encodeMoqVarint(64)], [64, 64]);
  assert.equal(serializeMoqFullTrackName(CONTEXT.namespace, CONTEXT.trackName).includes(Buffer.from("video-main")), true);
});

test("publisher and entitled subscriber authenticate and decrypt while a relay sees ciphertext only", () => {
  const publisher = context();
  const subscriber = context({ deviceRef: "dev_eeeeeeeeeeeeeeee" });
  install(publisher);
  install(subscriber);
  const sealed = publisher.seal(mediaObject());
  const forwarded = relaySecureMoqObject(sealed);

  assert.equal(forwarded.draftVersion, MOQ_SECURE_OBJECTS_DRAFT);
  assert.equal(forwarded.ciphertext.includes(Buffer.from("private-frame-payload")), false);
  assert.equal(forwarded.ciphertext.includes(Buffer.from("private-caption-property")), false);
  assert.notEqual(forwarded.ciphertext, sealed.ciphertext, "relay gets a copy, not publisher-owned mutable bytes");
  const opened = subscriber.open(forwarded);
  assert.equal(opened.payload.toString(), "private-frame-payload");
  assert.equal(opened.encryptedProperties.toString(), "private-caption-property");
});

test("relay modification of payload or authenticated routing metadata fails closed", () => {
  const publisher = context();
  install(publisher);
  const sealed = publisher.seal(mediaObject());
  for (const mutate of [
    (value) => { value.ciphertext[0] ^= 1; },
    (value) => { value.priority += 1; },
    (value) => { value.groupId += 1; },
    (value) => { value.objectId += 1; },
    (value) => { value.immutableProperties[value.immutableProperties.length - 1] ^= 1; },
  ]) {
    const subscriber = context({ deviceRef: "dev_eeeeeeeeeeeeeeee" });
    install(subscriber);
    const changed = { ...sealed,
      ciphertext: Buffer.from(sealed.ciphertext),
      immutableProperties: Buffer.from(sealed.immutableProperties),
    };
    mutate(changed);
    assert.throws(() => subscriber.open(changed), errorCode("secure_object_auth_failed"));
  }

  const wrongKeySubscriber = context({ deviceRef: "dev_eeeeeeeeeeeeeeee" });
  install(wrongKeySubscriber, 1, KEY_TWO);
  assert.throws(() => wrongKeySubscriber.open(sealed), errorCode("secure_object_auth_failed"));
});

test("nonce reuse and subscriber replay are rejected", () => {
  const publisher = context();
  const subscriber = context({ deviceRef: "dev_eeeeeeeeeeeeeeee" });
  install(publisher);
  install(subscriber);
  const sealed = publisher.seal(mediaObject());
  assert.throws(() => publisher.seal(mediaObject()), errorCode("secure_object_nonce_reuse"));
  assert.equal(subscriber.open(sealed).payload.length > 0, true);
  assert.throws(() => subscriber.open(sealed), errorCode("secure_object_replay"));
});

test("rotation, late join, revocation and device loss keep explicit key scope", () => {
  const publisher = context();
  install(publisher, 1, KEY_ONE);
  const first = publisher.seal(mediaObject());
  publisher.addKey({ keyId: 2, trackBaseKey: KEY_TWO, notBefore: NOW - 1_000, expiresAt: NOW + 60_000 });
  publisher.activateKey(2);
  const second = publisher.seal(mediaObject({ groupId: 10 }));

  const lateJoiner = context({ deviceRef: "dev_ffffffffffffffff" });
  install(lateJoiner, 2, KEY_TWO);
  assert.throws(() => lateJoiner.open(first), errorCode("secure_object_key_unavailable"));
  assert.equal(lateJoiner.open(second).payload.toString(), "private-frame-payload");
  assert.equal(lateJoiner.revokeKey(2), true);
  assert.throws(() => lateJoiner.open(publisher.seal(mediaObject({ groupId: 11 }))),
    errorCode("secure_object_key_unavailable"));

  const lost = context({ deviceRef: "dev_gggggggggggggggg" });
  install(lost, 2, KEY_TWO);
  assert.equal(lost.loseDevice("dev_otherxxxxxxxxxxxx"), false);
  assert.equal(lost.loseDevice("dev_gggggggggggggggg"), true);
  assert.throws(() => lost.open(second), errorCode("secure_object_context_destroyed"));
});

test("experimental feature flag, object-id width and invocation budget are hard gates", () => {
  const disabled = context({ enabled: false });
  install(disabled);
  assert.throws(() => disabled.seal(mediaObject()), errorCode("secure_objects_disabled"));

  const publisher = context({ maxObjectsPerKey: 1 });
  install(publisher);
  publisher.seal(mediaObject());
  assert.throws(() => publisher.seal(mediaObject({ groupId: 10 })), errorCode("secure_object_key_limit_reached"));

  const width = context();
  install(width);
  assert.throws(() => width.seal(mediaObject({ objectId: 0x1_0000_0000 })),
    errorCode("invalid_secure_object_object_id"));
});
