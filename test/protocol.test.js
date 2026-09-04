import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SIGNAL_BYTES,
  normalizeDisplayName,
  normalizeRoomId,
  parseClientMessage,
  ProtocolError,
} from "../src/protocol.js";

const recipient = "0123456789abcdef";

test("room and display names are normalized and bounded", () => {
  assert.equal(normalizeRoomId(" Room-Abc123 "), "room-abc123");
  assert.equal(normalizeDisplayName("  Ada   Lovelace "), "Ada Lovelace");
  assert.throws(() => normalizeRoomId("short"), ProtocolError);
  assert.throws(() => normalizeDisplayName("bad\nname"), ProtocolError);
});

test("parseClientMessage accepts closed SDP and ICE signals", () => {
  assert.deepEqual(parseClientMessage(Buffer.from(JSON.stringify({
    type: "signal",
    to: recipient,
    description: { type: "offer", sdp: "v=0", ignored: true },
  }))), {
    type: "signal",
    to: recipient,
    description: { type: "offer", sdp: "v=0" },
  });
  assert.deepEqual(parseClientMessage(Buffer.from(JSON.stringify({
    type: "signal", to: recipient, candidate: null,
  }))), { type: "signal", to: recipient, candidate: null });
});

test("parseClientMessage accepts only an exact explicit leave control", () => {
  assert.deepEqual(parseClientMessage(Buffer.from(JSON.stringify({
    type: "leave",
  }))), { type: "leave" });
  assert.throws(() => parseClientMessage(Buffer.from(JSON.stringify({
    type: "leave", roomId: "room-alpha",
  }))), (error) => error.code === "unknown_message_field");
});

test("parseClientMessage validates media metadata and rejects unknown traffic", () => {
  assert.deepEqual(parseClientMessage(Buffer.from(JSON.stringify({
    type: "media-state", source: "camera", active: true, trackId: "track-1",
  }))), { type: "media-state", source: "camera", active: true, trackId: "track-1" });
  assert.deepEqual(parseClientMessage(Buffer.from(JSON.stringify({
    type: "media-state", source: "camera", active: true,
    trackId: "{4afe877a-4644-44d0-85f4-bee3af582e89}",
  }))).trackId, "{4afe877a-4644-44d0-85f4-bee3af582e89}");
  assert.throws(
    () => parseClientMessage(Buffer.from(JSON.stringify({ type: "chat", text: "server must not relay this" }))),
    (error) => error.code === "unknown_message_type",
  );
  assert.throws(
    () => parseClientMessage(Buffer.alloc(MAX_SIGNAL_BYTES + 1, 0x20)),
    (error) => error.code === "message_too_large",
  );
});

test("parseClientMessage requires exactly one signal payload", () => {
  assert.throws(() => parseClientMessage(Buffer.from(JSON.stringify({
    type: "signal", to: recipient,
  }))), (error) => error.code === "invalid_signal");
  assert.throws(() => parseClientMessage(Buffer.from(JSON.stringify({
    type: "signal", to: recipient, description: { type: "offer", sdp: "v=0" }, candidate: null,
  }))), (error) => error.code === "invalid_signal");
});

test("parseClientMessage accepts only closed relay consent", () => {
  assert.deepEqual(parseClientMessage(Buffer.from(JSON.stringify({
    type: "relay-consent", enabled: true,
  }))), { type: "relay-consent", enabled: true });
  assert.throws(() => parseClientMessage(Buffer.from(JSON.stringify({
    type: "relay-consent", enabled: true, ignored: "rejected",
  }))), (error) => error.code === "unknown_message_field");
  assert.throws(() => parseClientMessage(Buffer.from(JSON.stringify({
    type: "relay-consent", enabled: "yes",
  }))), (error) => error.code === "invalid_relay_consent");
});

test("parseClientMessage validates closed relay capability and health observations", () => {
  assert.deepEqual(parseClientMessage(Buffer.from(JSON.stringify({
    type: "relay-capability",
    visible: true,
    battery: "mains",
    network: "fast",
    selfCapacity: 80,
  }))), {
    type: "relay-capability",
    visible: true,
    battery: "mains",
    network: "fast",
    selfCapacity: 80,
  });
  assert.deepEqual(parseClientMessage(Buffer.from(JSON.stringify({
    type: "relay-observation",
    relayPeerId: recipient,
    routeEpoch: 3,
    sampleCount: 5,
    deliveryRatio: 0.7,
    delayMs: 3200,
    observedCapacity: 20,
  }))).routeEpoch, 3);
  assert.throws(() => parseClientMessage(Buffer.from(JSON.stringify({
    type: "relay-capability", visible: true, battery: "full", network: "fast", selfCapacity: 80,
  }))), (error) => error.code === "invalid_battery_state");
  assert.throws(() => parseClientMessage(Buffer.from(JSON.stringify({
    type: "relay-observation", relayPeerId: recipient, routeEpoch: 0, sampleCount: 5,
    deliveryRatio: 1.1, delayMs: 0, observedCapacity: 100,
  }))), ProtocolError);
});

test("parseClientMessage accepts only a closed P-256 overlay public key", () => {
  const coordinate = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.deepEqual(parseClientMessage(Buffer.from(JSON.stringify({
    type: "overlay-key",
    key: { kty: "EC", crv: "P-256", x: coordinate, y: coordinate, ext: true },
  }))).key.kty, "EC");
  assert.throws(() => parseClientMessage(Buffer.from(JSON.stringify({
    type: "overlay-key",
    key: { kty: "EC", crv: "P-384", x: coordinate, y: coordinate, ext: true },
  }))), (error) => error.code === "invalid_overlay_key");
});

test("parseClientMessage accepts only assignment-bound native packager signals", () => {
  const signal = {
    version: 1,
    type: "native-packager-signal",
    packagerId: "pkr_0123456789abcdef",
    assignmentId: "asn_0123456789abcdef",
    programId: "prg_0123456789abcdef",
    programEpoch: 2,
    fencingRevision: 3,
    description: { type: "offer", sdp: "v=0\r\n" },
  };
  assert.deepEqual(parseClientMessage(JSON.stringify(signal)), signal);
  assert.throws(() => parseClientMessage(JSON.stringify({ ...signal, token: "forbidden" })), /invalid_native_packager_signal/);
  assert.throws(() => parseClientMessage(JSON.stringify({ ...signal, candidate: null })), /invalid_native_packager_signal/);
});
