import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  BROADCAST_CONTRACT_SCHEMA_FILES,
  BroadcastContractError,
  MAX_BROADCAST_CONTRACT_BYTES,
  parseBroadcastContract,
  validateBroadcastContract,
} from "../src/broadcast-contracts.js";
import {
  MAX_BROADCAST_AGGREGATE_ITEMS,
  validateBroadcastAggregate,
} from "../src/broadcast-aggregate.js";
import { assertBroadcastTransition } from "../src/broadcast-transitions.js";

const CONTRACT_ROOT = new URL("../contracts/broadcast/", import.meta.url);
const FIXTURE_URL = new URL("fixtures/contract-fixtures.v1.json", CONTRACT_ROOT);
const NOW = 1_800_000_000_500;

const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));
const fixtures = async () => readJson(FIXTURE_URL);

const errorCode = (code) => (error) => (
  error instanceof BroadcastContractError && error.code === code
);

const byType = (fixtureSet) => new Map(fixtureSet.cases.map((entry) => [entry.type, entry]));

test("all thirteen broadcast schemas compile strictly and keep v1 objects closed", async () => {
  const expectedTypes = [
    "broadcast-program",
    "program-source",
    "publication",
    "rendition",
    "delivery-endpoint",
    "provider-capability",
    "consent",
    "lease",
    "grant",
    "viewer-policy",
    "caption-track",
    "health",
    "event",
  ];
  assert.deepEqual(Object.keys(BROADCAST_CONTRACT_SCHEMA_FILES).sort(), expectedTypes.sort());

  const files = (await readdir(CONTRACT_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".schema.json"))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(files, ["common.v1.schema.json", ...Object.values(BROADCAST_CONTRACT_SCHEMA_FILES)].sort());

  const schemas = await Promise.all(files.map((file) => readJson(new URL(file, CONTRACT_ROOT))));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of schemas) ajv.addSchema(schema);
  for (const [type, file] of Object.entries(BROADCAST_CONTRACT_SCHEMA_FILES)) {
    const schema = schemas.find((candidate) => candidate.$id.endsWith(`/${file}`));
    assert.ok(schema, `${type} schema is missing`);
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.required.includes("contractVersion"));
    assert.ok(schema.required.includes("type"));
    assert.ok(schema.required.includes("tenantId"));
    assert.equal(ajv.getSchema(schema.$id) !== undefined, true);
  }
});

test("minimal, full and negative fixture for every contract family remain compatible", async () => {
  const fixtureSet = await fixtures();
  assert.equal(fixtureSet.version, 1);
  assert.equal(fixtureSet.cases.length, 13);
  assert.equal(new Set(fixtureSet.cases.map((entry) => entry.type)).size, 13);

  for (const fixture of fixtureSet.cases) {
    assert.equal(BROADCAST_CONTRACT_SCHEMA_FILES[fixture.type], fixture.schema);
    const minimal = validateBroadcastContract(fixture.minimal, { requireFresh: false }, NOW);
    const full = validateBroadcastContract(fixture.full, { requireFresh: false }, NOW);
    assert.deepEqual(minimal, fixture.minimal);
    assert.deepEqual(full, fixture.full);
    assert.equal(Object.isFrozen(minimal), true);
    assert.throws(
      () => validateBroadcastContract(
        { ...fixture.minimal, ...fixture.invalidPatch },
        { requireFresh: false },
        NOW,
      ),
      BroadcastContractError,
      `${fixture.type} must reject ${fixture.invalidReason}`,
    );
  }
});

test("wire parser bounds JSON, versions, types and unknown fields before domain use", async () => {
  const program = byType(await fixtures()).get("broadcast-program").minimal;
  const parsed = parseBroadcastContract(Buffer.from(JSON.stringify(program)), {}, NOW);
  assert.deepEqual(parsed, program);
  assert.equal(Object.isFrozen(parsed), true);

  assert.throws(
    () => parseBroadcastContract(Buffer.alloc(MAX_BROADCAST_CONTRACT_BYTES + 1, 0x20)),
    errorCode("broadcast_contract_too_large"),
  );
  assert.throws(() => parseBroadcastContract("{"), errorCode("invalid_broadcast_json"));
  assert.throws(() => parseBroadcastContract("[]"), errorCode("invalid_broadcast_contract"));
  assert.throws(
    () => parseBroadcastContract(JSON.stringify({ ...program, contractVersion: 2 })),
    errorCode("unsupported_broadcast_contract_version"),
  );
  assert.throws(
    () => parseBroadcastContract(JSON.stringify({ contractVersion: 1, type: "room-admin" })),
    errorCode("unknown_broadcast_contract_type"),
  );
  assert.throws(
    () => parseBroadcastContract(JSON.stringify({ ...program, token: "forbidden" })),
    errorCode("invalid_broadcast_contract"),
  );
});

test("server boundary enforces exact tenant, room, program, epoch and principal bindings", async () => {
  const fixtureIndex = byType(await fixtures());
  const program = fixtureIndex.get("broadcast-program").minimal;
  const context = {
    tenantId: program.tenantId,
    roomId: program.roomId,
    programId: program.programId,
    programEpoch: program.programEpoch,
    allowedSubjectRefs: [program.ownerSubjectRef],
  };
  assert.deepEqual(validateBroadcastContract(program, context, NOW), program);

  for (const [field, value, code] of [
    ["tenantId", "tn_zzzzzzzzzzzzzzzz", "broadcast_tenant_id_mismatch"],
    ["roomId", "room-other", "broadcast_room_id_mismatch"],
    ["programId", "prg_zzzzzzzzzzzzzzzz", "broadcast_program_id_mismatch"],
    ["programEpoch", 8, "broadcast_program_epoch_mismatch"],
  ]) {
    assert.throws(
      () => validateBroadcastContract(program, { ...context, [field]: value }, NOW),
      errorCode(code),
    );
  }
  assert.throws(
    () => validateBroadcastContract(program, { ...context, allowedSubjectRefs: ["sub_zzzzzzzzzzzzzzzz"] }, NOW),
    errorCode("broadcast_subject_mismatch"),
  );

  const consent = fixtureIndex.get("consent").minimal;
  assert.throws(
    () => validateBroadcastContract(consent, {
      allowedPrincipalRefs: ["pkr_zzzzzzzzzzzzzzzz"],
    }, NOW),
    errorCode("broadcast_principal_mismatch"),
  );
  assert.throws(
    () => validateBroadcastContract(program, { unexpectedAuthority: true }, NOW),
    errorCode("invalid_broadcast_context"),
  );
});

test("freshness and timestamp order fail closed without making historical objects unparsable", async () => {
  const fixtureIndex = byType(await fixtures());
  const consent = fixtureIndex.get("consent").minimal;
  assert.throws(
    () => validateBroadcastContract(consent, {}, consent.expiresAt),
    errorCode("expired_broadcast_contract"),
  );
  assert.doesNotThrow(() => validateBroadcastContract(consent, { requireFresh: false }, consent.expiresAt));

  const grant = fixtureIndex.get("grant").minimal;
  assert.throws(
    () => validateBroadcastContract({ ...grant, notBefore: NOW + 1_000 }, {}, NOW),
    errorCode("broadcast_grant_not_yet_valid"),
  );
  assert.throws(
    () => validateBroadcastContract({ ...grant, expiresAt: grant.issuedAt - 1 }, { requireFresh: false }, NOW),
    errorCode("invalid_broadcast_time_order"),
  );
  const program = fixtureIndex.get("broadcast-program").minimal;
  assert.throws(
    () => validateBroadcastContract({ ...program, updatedAt: program.createdAt - 1 }, {}, NOW),
    errorCode("invalid_broadcast_time_order"),
  );
});

test("aggregate validation resolves only same-scope, consented and runtime-capable references", async () => {
  const fixtureSet = await fixtures();
  const fixtureIndex = byType(fixtureSet);
  const aggregate = fixtureSet.cases.map((fixture) => (
    fixture.type === "lease" ? fixture.minimal : fixture.full
  ));
  const context = {
    tenantId: "tn_aaaaaaaaaaaaaaaa",
    roomId: "room-alpha",
    programId: "prg_aaaaaaaaaaaaaaaa",
    programEpoch: 7,
  };
  const validated = validateBroadcastAggregate(aggregate, context, NOW);
  assert.equal(validated.length, 13);
  assert.equal(Object.isFrozen(validated), true);

  const replace = (type, mutate) => aggregate.map((value) => (
    value.type === type ? mutate(value) : value
  ));
  assert.throws(
    () => validateBroadcastAggregate(replace("program-source", (value) => ({
      ...value,
      tenantId: "tn_zzzzzzzzzzzzzzzz",
    })), {}, NOW),
    errorCode("broadcast_tenant_id_mismatch"),
  );
  assert.throws(
    () => validateBroadcastAggregate(replace("program-source", (value) => ({
      ...value,
      roomId: "room-other",
    })), {}, NOW),
    errorCode("broadcast_room_id_mismatch"),
  );
  assert.throws(
    () => validateBroadcastAggregate(replace("broadcast-program", (value) => ({
      ...value,
      sourceIds: ["src_zzzzzzzzzzzzzzzz"],
    })), {}, NOW),
    errorCode("unknown_broadcast_reference"),
  );
  assert.throws(
    () => validateBroadcastAggregate(replace("provider-capability", () => (
      fixtureIndex.get("provider-capability").minimal
    )), {}, NOW),
    errorCode("unsupported_broadcast_delivery_capability"),
  );
  assert.throws(
    () => validateBroadcastAggregate(replace("consent", (value) => ({
      ...value,
      status: "revoked",
      revokedAt: NOW,
    })), {}, NOW),
    errorCode("invalid_broadcast_source_consent"),
  );
  assert.throws(
    () => validateBroadcastAggregate(replace("viewer-policy", (value) => ({
      ...value,
      visibility: "private",
      authentication: "required",
      directoryListed: false,
      anonymousAllowed: false,
    })), {}, NOW),
    errorCode("broadcast_visibility_mismatch"),
  );

  const secondLease = {
    ...fixtureIndex.get("lease").minimal,
    leaseId: "lea_zzzzzzzzzzzzzzzz",
    holderRef: "pkr_zzzzzzzzzzzzzzzz",
  };
  assert.throws(
    () => validateBroadcastAggregate([...aggregate, secondLease], {}, NOW),
    errorCode("duplicate_active_broadcast_writer"),
  );
  assert.throws(
    () => validateBroadcastAggregate(
      Array(MAX_BROADCAST_AGGREGATE_ITEMS + 1).fill(fixtureIndex.get("broadcast-program").minimal),
      {},
      NOW,
    ),
    errorCode("invalid_broadcast_aggregate"),
  );
});

test("state transitions are revision-bound, epoch-bound and terminal states stay terminal", async () => {
  const fixtureIndex = byType(await fixtures());
  const validTransitions = [
    ["broadcast-program", "preparing"],
    ["program-source", "active"],
    ["publication", "starting"],
    ["rendition", "active"],
    ["delivery-endpoint", "ready"],
    ["consent", "revoked", { revokedAt: NOW }],
    ["lease", "released", { releasedAt: NOW }],
    ["grant", "consumed", { consumedAt: NOW }],
    ["caption-track", "active"],
  ];
  for (const [type, nextState, extra = {}] of validTransitions) {
    const previous = fixtureIndex.get(type).minimal;
    const stateField = ["consent", "lease", "grant"].includes(type) ? "status" : "state";
    const next = {
      ...previous,
      revision: previous.revision + 1,
      [stateField]: nextState,
      ...(previous.updatedAt !== undefined ? { updatedAt: previous.updatedAt + 1 } : {}),
      ...extra,
    };
    assert.deepEqual(assertBroadcastTransition(previous, next, {}, NOW), next, `${type} transition`);
  }

  const liveProgram = fixtureIndex.get("broadcast-program").full;
  assert.throws(
    () => assertBroadcastTransition(liveProgram, {
      ...liveProgram,
      revision: liveProgram.revision + 1,
      state: "draft",
      updatedAt: liveProgram.updatedAt + 1,
    }, {}, NOW),
    errorCode("invalid_broadcast_transition"),
  );
  assert.throws(
    () => assertBroadcastTransition(fixtureIndex.get("broadcast-program").minimal, {
      ...fixtureIndex.get("broadcast-program").minimal,
      revision: 3,
      state: "preparing",
    }, {}, NOW),
    errorCode("stale_broadcast_revision"),
  );
  assert.throws(
    () => assertBroadcastTransition(fixtureIndex.get("broadcast-program").minimal, {
      ...fixtureIndex.get("broadcast-program").minimal,
      revision: 2,
      state: "preparing",
      roomId: "room-other",
    }, {}, NOW),
    errorCode("broadcast_transition_binding_mismatch"),
  );
  assert.throws(
    () => assertBroadcastTransition(
      fixtureIndex.get("viewer-policy").minimal,
      { ...fixtureIndex.get("viewer-policy").minimal, revision: 2 },
      {},
      NOW,
    ),
    errorCode("unsupported_broadcast_transition"),
  );
});

test("schemas expose no token, secret, SDP, ICE, caption text or media payload field", async () => {
  const forbidden = new Set([
    "token",
    "tokens",
    "accessToken",
    "refreshToken",
    "secret",
    "sharedSecret",
    "privateKey",
    "sdp",
    "ice",
    "candidate",
    "candidates",
    "captionText",
    "transcript",
    "payload",
    "mediaBytes",
    "mediaData",
    "url",
    "playbackUrl",
    "publishUrl",
  ]);
  const files = ["common.v1.schema.json", ...Object.values(BROADCAST_CONTRACT_SCHEMA_FILES)];
  const visit = (value, path = "$") => {
    if (Array.isArray(value)) return value.forEach((child, index) => visit(child, `${path}[${index}]`));
    if (!value || typeof value !== "object") return;
    if (value.properties) {
      for (const field of Object.keys(value.properties)) {
        assert.equal(forbidden.has(field), false, `${path} exposes forbidden ${field}`);
      }
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
  };
  for (const file of files) visit(await readJson(new URL(file, CONTRACT_ROOT)), file);
});
