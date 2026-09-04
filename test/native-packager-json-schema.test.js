import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

test("native packager control schemas are closed and reject authority injection", async () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const load = async (name) => JSON.parse(await readFile(new URL(`../contracts/native-packager/${name}`, import.meta.url), "utf8"));
  const client = ajv.compile(await load("client-control.v1.schema.json"));
  const server = ajv.compile(await load("server-control.v1.schema.json"));
  const authentication = { version: 1, type: "authenticate", packagerId: "pkr_0123456789abcdef", timestamp: 1_800_000_000_000, proof: "A".repeat(86) };
  assert.equal(client(authentication), true, JSON.stringify(client.errors));
  assert.equal(client({ ...authentication, roomAuthority: true }), false);
  assert.equal(server({ version: 1, type: "room-consent-sync", roomIds: ["room-1234"] }), true, JSON.stringify(server.errors));
  assert.equal(server({ version: 1, type: "room-consent-sync", roomIds: ["room-1234"], decryptKey: "forbidden" }), false);
});
