import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  MAX_MOQ_CATALOG_BYTES,
  MAX_MOQ_OBJECT_BYTES,
  MOQ_CONTRACT_SCHEMA_FILES,
  MOQ_PROTOCOL_PINS,
  MoqContractError,
  authorizeMoqSubscription,
  createMoqNamespace,
  negotiateMoqCapabilities,
  parseMoqContract,
  validateMoqContract,
  validateMoqObjectPayload,
} from "../src/moq-contracts.js";

const ROOT = new URL("../contracts/moq/", import.meta.url);
const NOW = 1_800_000_000_000;
const SCOPE = Object.freeze({
  tenantId: "tn_aaaaaaaaaaaaaaaa",
  programId: "prg_bbbbbbbbbbbbbbbb",
  programEpoch: 7,
  audienceId: "aud_cccccccccccccccc",
});
const NAMESPACE = createMoqNamespace(SCOPE);
const errorCode = (code) => (error) => error instanceof MoqContractError && error.code === code;

function capability(participantKind, patch = {}) {
  const prefixes = { browser: "brw", gateway: "gtw", provider: "prv" };
  return {
    contractVersion: 1,
    type: "moq-capability",
    ...SCOPE,
    participantKind,
    participantRef: `${prefixes[participantKind]}_${participantKind.padEnd(16, "x")}`,
    enabled: true,
    transportVersions: [MOQ_PROTOCOL_PINS.transport],
    locVersions: [MOQ_PROTOCOL_PINS.loc],
    webTransportVersions: [MOQ_PROTOCOL_PINS.webTransport],
    secureObjectVersions: [],
    codecs: ["h264", "aac"],
    fallbackProtocols: ["ll-hls", "hls"],
    extensions: ["loc-header-v04"],
    maxCatalogBytes: 65_536,
    maxObjectBytes: 1_048_576,
    observedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    ...patch,
  };
}

function catalog(patch = {}) {
  return {
    contractVersion: 1,
    type: "moq-catalog",
    ...SCOPE,
    namespace: NAMESPACE,
    catalogRevision: 1,
    tracks: [{
      trackName: "video-main",
      mediaKind: "video",
      codec: "h264",
      renditionId: "ren_dddddddddddddddd",
      priority: 32,
      maxObjectBytes: 262_144,
    }],
    extensions: ["loc-header-v04"],
    createdAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    ...patch,
  };
}

function subscription(patch = {}) {
  return {
    contractVersion: 1,
    type: "moq-subscription",
    ...SCOPE,
    namespace: NAMESPACE,
    trackName: "video-main",
    filter: { mode: "latest-group" },
    codecPreferences: ["h264"],
    renditionIds: ["ren_dddddddddddddddd"],
    priority: 32,
    maxObjects: 64,
    createdAt: NOW - 500,
    expiresAt: NOW + 30_000,
    ...patch,
  };
}

const policy = Object.freeze({
  moqEnabled: true,
  requireSecureObjects: false,
  preferredCodecs: ["h264", "aac"],
  allowedFallbackProtocols: ["ll-hls", "hls"],
});

test("all MoQ schemas compile strictly and keep metadata contracts closed", async () => {
  const files = (await readdir(ROOT)).filter((file) => file.endsWith(".schema.json")).sort();
  assert.deepEqual(files, ["common.v1.schema.json", ...Object.values(MOQ_CONTRACT_SCHEMA_FILES)].sort());
  const schemas = await Promise.all(files.map(async (file) => JSON.parse(await readFile(new URL(file, ROOT), "utf8"))));
  const validator = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of schemas) validator.addSchema(schema);
  for (const file of Object.values(MOQ_CONTRACT_SCHEMA_FILES)) {
    const schema = schemas.find((value) => value.$id.endsWith(`/${file}`));
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.required.includes("tenantId"));
    assert.ok(schema.required.includes("programId"));
    assert.ok(schema.required.includes("programEpoch"));
    assert.ok(schema.required.includes("audienceId"));
    assert.ok(validator.getSchema(schema.$id));
  }
});

test("capability negotiation pins exact drafts and falls back without widening scope", () => {
  const capabilities = [capability("browser"), capability("gateway"), capability("provider")];
  const selected = negotiateMoqCapabilities(capabilities, policy, SCOPE, NOW);
  assert.deepEqual(selected, {
    transport: "moq",
    experimental: true,
    reasonCode: "moq_compatible",
    ...SCOPE,
    moqtVersion: "draft-ietf-moq-transport-20",
    locVersion: "draft-ietf-moq-loc-04",
    webTransportVersion: "RFC 9297",
    secureObjectsVersion: null,
    codec: "h264",
    maxCatalogBytes: 65_536,
    maxObjectBytes: 1_048_576,
  });

  const incompatible = capabilities.map((value) => value.participantKind === "gateway"
    ? { ...value, transportVersions: ["draft-ietf-moq-transport-19"] }
    : value);
  assert.deepEqual(negotiateMoqCapabilities(incompatible, policy, SCOPE, NOW), {
    transport: "ll-hls",
    experimental: false,
    reasonCode: "moq_version_mismatch",
    ...SCOPE,
  });
  assert.equal(negotiateMoqCapabilities(capabilities, { ...policy, moqEnabled: false }, SCOPE, NOW).reasonCode,
    "moq_disabled");
});

test("unknown extensions, stale scope and cross-program capability sets fail closed", () => {
  assert.throws(
    () => validateMoqContract({ ...capability("browser"), extensions: ["vendor-magic"] }, SCOPE, NOW),
    errorCode("invalid_moq_contract"),
  );
  assert.throws(
    () => validateMoqContract(catalog({ programEpoch: 6 }), SCOPE, NOW),
    errorCode("moq_program_epoch_mismatch"),
  );
  assert.throws(
    () => validateMoqContract(catalog({ namespace: `${SCOPE.tenantId}/prg_zzzzzzzzzzzzzzzz/epoch/7` }), SCOPE, NOW),
    errorCode("moq_namespace_mismatch"),
  );
  assert.throws(
    () => negotiateMoqCapabilities([
      capability("browser"),
      capability("gateway", { programId: "prg_zzzzzzzzzzzzzzzz" }),
      capability("provider"),
    ], policy, {}, NOW),
    errorCode("moq_program_id_mismatch"),
  );
});

test("catalogs, object payloads, priorities and ranges stay bounded", () => {
  assert.throws(
    () => parseMoqContract(`${JSON.stringify(catalog())}${" ".repeat(MAX_MOQ_CATALOG_BYTES)}`, SCOPE, NOW),
    errorCode("moq_contract_too_large"),
  );
  assert.throws(
    () => validateMoqContract(catalog({ tracks: Array.from({ length: 33 }, (_, index) => ({
      ...catalog().tracks[0], trackName: `video-${index}`,
    })) }), SCOPE, NOW),
    errorCode("invalid_moq_contract"),
  );
  assert.throws(
    () => validateMoqContract(subscription({ priority: 256 }), SCOPE, NOW),
    errorCode("invalid_moq_contract"),
  );
  assert.throws(
    () => validateMoqContract(subscription({ filter: {
      mode: "absolute-range", startGroup: 4, startObject: 1, endGroup: 3, endObject: 9,
    } }), SCOPE, NOW),
    errorCode("invalid_moq_subscription_range"),
  );

  const tooLarge = Buffer.alloc(MAX_MOQ_OBJECT_BYTES + 1);
  const metadata = {
    contractVersion: 1,
    type: "moq-object",
    ...SCOPE,
    namespace: NAMESPACE,
    trackName: "video-main",
    groupId: 1,
    objectId: 2,
    priority: 32,
    status: "normal",
    payloadBytes: MAX_MOQ_OBJECT_BYTES,
    payloadSha256: "0".repeat(64),
    expiresAt: NOW + 5_000,
  };
  assert.throws(() => validateMoqObjectPayload(metadata, tooLarge, SCOPE, NOW), errorCode("moq_object_too_large"));

  const payload = Buffer.from("bounded-object");
  const validMetadata = {
    ...metadata,
    payloadBytes: payload.byteLength,
    payloadSha256: createHash("sha256").update(payload).digest("hex"),
  };
  assert.equal(validateMoqObjectPayload(validMetadata, payload, SCOPE, NOW).objectId, 2);
  assert.throws(
    () => validateMoqObjectPayload({ ...validMetadata, payloadSha256: "f".repeat(64) }, payload, SCOPE, NOW),
    errorCode("moq_object_digest_mismatch"),
  );
});

test("subscriptions resolve only an allowed track, rendition and audience", () => {
  const bound = authorizeMoqSubscription(subscription(), catalog(), SCOPE, NOW);
  assert.equal(bound.track.trackName, "video-main");
  assert.equal(Object.isFrozen(bound), true);
  assert.throws(
    () => authorizeMoqSubscription(subscription({ trackName: "video-private" }), catalog(), SCOPE, NOW),
    errorCode("unknown_moq_track"),
  );
  assert.throws(
    () => authorizeMoqSubscription(subscription({ renditionIds: ["ren_zzzzzzzzzzzzzzzz"] }), catalog(), SCOPE, NOW),
    errorCode("moq_subscription_rendition_denied"),
  );
  assert.throws(
    () => authorizeMoqSubscription(subscription({ audienceId: "aud_zzzzzzzzzzzzzzzz" }), catalog(), {}, NOW),
    errorCode("moq_audience_id_mismatch"),
  );
});
