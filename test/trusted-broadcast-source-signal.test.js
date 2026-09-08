import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv/dist/2020.js";
import { parseClientMessage } from "../src/protocol.js";
import { parseNativePackagerMessage } from "../src/native-packager-control.js";
import { parseTrustedSourceSignal, TrustedSourceNegotiation } from "../src/trusted-broadcast-source-signal.js";

const schema = JSON.parse(await fs.readFile(new URL("../contracts/trusted-decrypt/source-signal.v1.schema.json", import.meta.url), "utf8"));
const validate = new Ajv({ strict: true }).compile(schema);
const signal = (publisher = true, revision = 1, sequence = 1) => ({ version: 1,
  type: publisher ? "trusted-source-publisher-signal" : "trusted-source-packager-signal",
  sourceLeaseId: "sls_aaaaaaaaaaaaaaaa", consentId: "cns_aaaaaaaaaaaaaaaa", assignmentId: "asn_aaaaaaaaaaaaaaaa",
  fencingRevision: 1, negotiationRevision: revision, sequence,
  description: { type: publisher ? "offer" : "answer", sdp: "v=0\r\n" } });
function candidate(publisher, revision, sequence) {
  const message = signal(publisher, revision, sequence); delete message.description;
  message.candidate = { candidate: "candidate:1 1 UDP 1 127.0.0.1 1234 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "test" };
  return message;
}
const parse = value => parseTrustedSourceSignal(value, value.type);

test("source signal schemas match closed publisher/native parsers and server-only endpoint references", () => {
  for (const value of [signal(), signal(false), candidate(true, 1, 2), { ...candidate(false, 1, 2), candidate: null }]) {
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.deepEqual(parse(value), value);
    assert.deepEqual(value.type.includes("publisher") ? parseClientMessage(JSON.stringify(value)) : parseNativePackagerMessage(JSON.stringify(value)), value);
    for (const field of Object.keys(value)) {
      const bad = { ...value }; delete bad[field]; assert.equal(validate(bad), false); assert.throws(() => parseTrustedSourceSignal(bad, value.type));
    }
    for (const field of ["to", "keys", "baseKey", "roomId", "publisherPeerId", "packagerId"]) {
      assert.equal(validate({ ...value, [field]: "untrusted" }), false);
      assert.throws(() => parseTrustedSourceSignal({ ...value, [field]: "untrusted" }, value.type));
    }
  }
  const toNative = { ...signal(), type: "trusted-source-peer-signal", publisherPeerId: "0123456789abcdef" };
  const toBrowser = { ...signal(false), type: "trusted-source-agent-signal", packagerId: "pkr_aaaaaaaaaaaaaaaa", packagerDeviceRef: "dev_bbbbbbbbbbbbbbbb" };
  assert.equal(validate(toNative), true); assert.equal(validate(toBrowser), true);
  assert.throws(() => parseTrustedSourceSignal(toNative, toNative.type));
  assert.throws(() => parseTrustedSourceSignal(toBrowser, toBrowser.type));
});

test("source signal rejects wrong direction, unknown nested fields and byte or integer overflows", () => {
  for (const patch of [{ version: 2 }, { negotiationRevision: 17 }, { sequence: 130 }, { fencingRevision: 0 },
    { description: { type: "rollback", sdp: "v=0" } }, { description: { type: "answer", sdp: "v=0" } },
    { description: { type: "offer", sdp: "v=0", key: "forbidden" } }, { description: { type: "offer", sdp: "ä".repeat(8193) } },
    { description: { type: "offer", sdp: "\n".repeat(16384) } },
    { candidate: null }]) assert.throws(() => parse({ ...signal(), ...patch }));
  for (const bad of [{ ...candidate(true, 1, 2).candidate, key: "forbidden" }, { candidate: "ä".repeat(2049) },
    { candidate: "", sdpMid: 1 }, { candidate: "", sdpMLineIndex: 16 }, { candidate: "", usernameFragment: "a".repeat(65) }, { candidate: "", sdpMid: "ä".repeat(33) }]) {
    assert.throws(() => parse({ ...candidate(true, 1, 2), candidate: bad }));
  }
});

test("negotiation binds offer, answer, ordered candidates and replacement epochs without replay", () => {
  const state = new TrustedSourceNegotiation(); let now = 100000;
  const accept = message => state.accept(parse(message), now);
  assert.equal(accept(candidate(true, 1, 1)), false); assert.equal(accept(signal(false)), false);
  assert.equal(accept(signal()), true); assert.equal(accept(signal()), false);
  assert.equal(accept(candidate(false, 1, 1)), false);
  assert.equal(accept(candidate(true, 1, 2)), true);
  assert.equal(accept(signal(true, 2)), false, "no overlapping offer");
  assert.equal(accept(signal(false)), true);
  assert.equal(accept(candidate(false, 1, 2)), true);
  assert.equal(accept(candidate(false, 1, 2)), false);
  assert.equal(accept(candidate(true, 1, 4)), false);
  assert.equal(accept(candidate(true, 1, 3)), true);
  assert.equal(accept(signal(true, 2)), true);
  assert.equal(accept(candidate(true, 1, 4)), false, "previous ICE generation cannot leak into new SDP");
  assert.equal(accept(signal(false, 2)), true);
  for (let revision = 3; revision <= 16; revision++) {
    now += 10000;
    assert.equal(accept(signal(true, revision)), true); assert.equal(accept(signal(false, revision)), true);
  }
});

test("negotiation rate and total byte budgets remain bounded", () => {
  const state = new TrustedSourceNegotiation();
  assert.equal(state.accept(parse(signal()), 100000), true);
  for (let i = 2; i <= 64; i++) assert.equal(state.accept(parse(candidate(true, 1, i)), 100000), true);
  assert.equal(state.accept(parse(candidate(true, 1, 65)), 100000), false);
  assert.equal(state.accept(parse(candidate(true, 1, 65)), 110000), true);
  const bytes = new TrustedSourceNegotiation(); let stopped = false;
  assert.equal(bytes.accept(parse(signal()), 100000), true);
  assert.equal(bytes.accept(parse(signal(false)), 100000), true);
  for (let revision = 1; revision <= 16 && !stopped; revision++) {
    const now = 100000 + revision * 10000;
    if (revision > 1) { bytes.accept(parse(signal(true, revision)), now); bytes.accept(parse(signal(false, revision)), now); }
    for (let seq = 2; seq <= 50; seq++) {
      const message = { ...candidate(true, revision, seq), candidate: { candidate: "a".repeat(4096) } };
      if (!bytes.accept(parse(message), now)) { stopped = true; break; }
    }
  }
  assert.equal(stopped, true, "lifetime bytes cannot grow with renewals");
});
