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

test("parseClientMessage validates media metadata and rejects unknown traffic", () => {
  assert.deepEqual(parseClientMessage(Buffer.from(JSON.stringify({
    type: "media-state", source: "camera", active: true, trackId: "track-1",
  }))), { type: "media-state", source: "camera", active: true, trackId: "track-1" });
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
