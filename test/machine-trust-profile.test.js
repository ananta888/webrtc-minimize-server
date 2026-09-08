import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { parseMachineTrustProfile } from "../src/machine-trust-profile.js";
import { parseMachineTrustJson } from "../src/machine-trust-json.js";
import { readMachineTrustFile } from "../src/machine-trust-file.js";
import { MachineAdmission } from "../src/machine-admission.js";
import { trustFixture } from "./helpers/machine-trust.mjs";

test("closed public profile is copied and deeply immutable, empty scopes deny", () => {
  const { profile } = trustFixture();
  const parsed = parseMachineTrustProfile(profile);
  assert.deepEqual(parsed, profile);
  profile.keys[0].kid = "changed"; profile.scopes[0].capabilities.length = 0; profile.audiences.length = 0;
  assert.equal(parsed.keys[0].kid, "synthetic-0");
  assert.equal(parsed.scopes[0].capabilities.length, 5); assert.equal(parsed.audiences.length, 2);
  for (const value of [parsed, parsed.keys, ...parsed.keys, parsed.scopes, ...parsed.scopes,
    parsed.scopes[0].capabilities, parsed.audiences]) assert.equal(Object.isFrozen(value), true);
  assert.equal(new MachineAdmission({ trustProfile: { ...parsed, scopes: [] } }).enabled, false);
});

const mutations = {
  schema: p => { p.schema = "v2"; }, revision: p => { p.revision = true; }, zeroRevision: p => { p.revision = 0; },
  extra: p => { p.jwks = "https://untrusted.test"; }, issuerPath: p => { p.issuer += "/path"; },
  http: p => { p.issuer = "http://synthetic.test"; }, issuerCredentials: p => { p.issuer = "https://user:secret@example.test"; },
  audiencesEmpty: p => { p.audiences = []; }, audienceUnknown: p => { p.audiences = ["human"]; },
  audienceDuplicate: p => { p.audiences = [p.audiences[0], p.audiences[0]]; },
  keysEmpty: p => { p.keys = []; }, keysOverflow: p => { p.keys = Array(5).fill(p.keys[0]); },
  keyDuplicate: p => { p.keys[1].x = p.keys[0].x; }, kidDuplicate: p => { p.keys[1].kid = p.keys[0].kid; },
  kidUnknownType: p => { p.keys[0].kid = 1; }, kidPath: p => { p.keys[0].kid = "../secret"; },
  kidOversize: p => { p.keys[0].kid = "x".repeat(65); }, privateMaterial: p => { p.keys[0].d = "private-marker"; },
  publicInvalid: p => { p.keys[0].x = "bad"; }, publicNoncanonical: p => { p.keys[0].x = "A".repeat(42) + "B"; },
  timeBool: p => { p.keys[0].notBefore = false; }, timeNaN: p => { p.keys[0].notAfter = NaN; },
  timeInverted: p => { p.keys[0].notAfter = p.keys[0].notBefore; }, timeOverflow: p => { p.keys[0].notAfter = 8640000000001; },
  scopesMissing: p => { delete p.scopes; }, scopesOverflow: p => { p.scopes = Array(129).fill(p.scopes[0]); },
  scopeDuplicate: p => { p.scopes.push({ ...p.scopes[0], capabilities: [] }); },
  scopeWildcard: p => { p.scopes[0].tenantId = "*"; }, scopeExtra: p => { p.scopes[0].organizationId = "invented"; },
  scopeSubject: p => { p.scopes[0].subject = ""; }, capabilityMissing: p => { delete p.scopes[0].capabilities; },
  capabilityUndefined: p => { p.scopes[0].capabilities = undefined; },
  capabilityDuplicate: p => { p.scopes[0].capabilities = ["chat.send", "chat.send"]; },
  capabilityEscalation: p => { p.scopes[0].capabilities = ["tools.execute"]; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`profile rejects ${name}`, () => {
  const { profile } = trustFixture(); mutate(profile);
  assert.throws(() => parseMachineTrustProfile(profile), /^Error: machine_trust_profile_invalid$/);
});

test("bounded JSON rejects duplicate and escaped keys at every nested depth", () => {
  for (const raw of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"a":[{"x":1,"x":2}]}',
    '[{"x":1},{"a":{"b":0,"b":1}}]', "[".repeat(9) + "0" + "]".repeat(9), "{}" + " ".repeat(65536), "{", ""]) {
    assert.throws(() => parseMachineTrustJson(raw), /^Error: machine_trust_json_invalid$/);
  }
  const raw = '{"a":[{"x":1},{"x":2}],"text":"\\\"x\\\": { \\u0022x\\u0022","a:b":true}';
  assert.deepEqual(parseMachineTrustJson(raw), JSON.parse(raw));
  assert.deepEqual(parseMachineTrustJson('[{"__proto__":1}]'), JSON.parse('[{"__proto__":1}]'));
});

test("environment profile is opt-in, bounded and cannot downgrade or mix trust", () => {
  const { profile } = trustFixture(), raw = JSON.stringify(profile);
  assert.equal(loadConfig({}).machineHubTrustProfile, null);
  assert.deepEqual(loadConfig({ MACHINE_HUB_TRUST_PROFILE_JSON: raw }).machineHubTrustProfile, parseMachineTrustProfile(profile));
  for (const extra of [{ MACHINE_HUB_ISSUER: profile.issuer }, { MACHINE_HUB_PUBLIC_KEY: "key" },
    { MACHINE_HUB_PUBLIC_KEY_FILE: "unreadable" }, { MACHINE_HUB_TRUST_PROFILE_JSON_FILE: "unreadable" }]) {
    assert.throws(() => loadConfig({ MACHINE_HUB_TRUST_PROFILE_JSON: raw, ...extra }));
  }
  for (const invalid of ["null", "{}", "[]", "malformed", raw.replace('"revision":1', '"revision":1,"revision":2')]) {
    assert.throws(() => loadConfig({ MACHINE_HUB_TRUST_PROFILE_JSON: invalid }), /machine_trust_profile_invalid/);
  }
  assert.throws(() => new MachineAdmission({ trustProfile: profile, issuer: profile.issuer }), /ambiguous/);
  assert.throws(() => new MachineAdmission({ trustProfile: profile, publicKey: "key" }), /ambiguous/);
});

test("profile file reads regular snapshots only and rejects FIFO without waiting", { timeout: 5000 }, t => {
  const directory = mkdtempSync(pathJoin(tmpdir(), "synthetic-machine-trust-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = pathJoin(directory, "public.json"), link = pathJoin(directory, "mount.json");
  const { profile } = trustFixture(); writeFileSync(file, JSON.stringify(profile)); symlinkSync(file, link);
  assert.equal(readMachineTrustFile(link), JSON.stringify(profile));
  assert.deepEqual(loadConfig({ MACHINE_HUB_TRUST_PROFILE_JSON_FILE: link }).machineHubTrustProfile, parseMachineTrustProfile(profile));
  const fifo = pathJoin(directory, "fifo"); execFileSync("mkfifo", [fifo], { timeout: 1000 });
  const folder = pathJoin(directory, "folder"); mkdirSync(folder);
  const empty = pathJoin(directory, "empty"); writeFileSync(empty, "");
  const oversized = pathJoin(directory, "oversized"); writeFileSync(oversized, "x".repeat(65537));
  const invalidUtf8 = pathJoin(directory, "invalid-utf8"); writeFileSync(invalidUtf8, Buffer.from([0xff]));
  // Child process timeout proves a regression cannot hang the test runner.
  const loader = new URL("../src/machine-trust-file.js", import.meta.url).href;
  const result = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import {readMachineTrustFile} from ${JSON.stringify(loader)};
     try { readMachineTrustFile(process.argv[1]); process.exit(3); }
     catch (e) { if (e.message !== 'machine_trust_file_invalid') process.exit(4); }`, fifo], { timeout: 1500 });
  assert.equal(result.length, 0);
  for (const path of [folder, empty, oversized, invalidUtf8, pathJoin(directory, "missing"), null, 4, "private\0marker"]) {
    assert.throws(() => readMachineTrustFile(path), /^Error: machine_trust_file_invalid$/);
  }
});
