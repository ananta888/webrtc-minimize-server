import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { MachineAdmission } from "../src/machine-admission.js";
import { MachineSessionLeases } from "../src/machine-session-leases.js";
import { bindMachineTrustReload, createMachineTrustReload, machineTrustReloadFile } from "../src/machine-trust-reload.js";
import { trustFixture, join } from "./helpers/machine-trust.mjs";

function fixture(t) {
  const f = trustFixture(), now = f.now * 1000;
  const admission = new MachineAdmission({ trustProfile: f.profile });
  const sessions = new MachineSessionLeases({ clock: () => now, authorize: (identity, time) => admission.current(identity, time) });
  t.after(() => sessions.destroy());
  let raw = JSON.stringify(f.profile);
  const reload = createMachineTrustReload({ file: "/synthetic/public.json", profile: f.profile, admission, sessions,
    read: () => { if (raw instanceof Error) throw raw; return raw; } });
  const replace = profile => { raw = profile instanceof Error ? profile : JSON.stringify(profile); return reload(); };
  const verify = async (changes = {}, key = 0) => admission.verify(`Bearer ${await f.token(changes, key)}`, join, now);
  return { ...f, admission, sessions, replace, verify, now };
}

test("live trust rotation retains allowed machines, revokes removed-key membership and pending leases", async t => {
  const f = fixture(t), old = await f.verify(), kept = await f.verify({ taskId: "other" }, 1);
  const a = f.sessions.issue(old, "one"), b = f.sessions.issue(kept, "two");
  const pending = f.sessions.issue(await f.verify({ taskId: "pending" }), "three");
  const events = [];
  f.sessions.attach(a.sessionId, () => true, reason => events.push(reason), null, null, () => {
    assert.equal(f.sessions.live(a.sessionId), false, "authority is removed before reentrant cleanup");
    events.push("detach"); return true;
  });
  f.sessions.attach(b.sessionId, () => true, () => events.push("unwanted"));
  assert.equal(f.replace({ ...f.profile, revision: 2, keys: [f.profile.keys[1]] }).status, "updated");
  assert.deepEqual(events, ["detach", "machine_session_trust_revoked"]);
  assert.equal(f.sessions.live(a.sessionId), false); assert.equal(f.sessions.live(pending.sessionId), false);
  assert.equal(f.sessions.live(b.sessionId), true);
  const fresh = await f.verify({ taskId: "other", exp: f.profile.keys[1].notBefore + 400 }, 1);
  assert.equal(f.sessions.renew(b.sessionId, 1, fresh, "two").generation, 2);
  assert.equal(f.admission.current({ ...kept }, f.now), false, "identity copies have no private verification evidence");
});

for (const mutation of ["scope", "capability", "audience", "window", "material"]) {
  test(`live trust revokes the old grant on ${mutation} removal`, async t => {
    const f = fixture(t), identity = await f.verify(), lease = f.sessions.issue(identity, "one");
    const profile = structuredClone(f.profile); profile.revision++;
    if (mutation === "scope") profile.scopes = [];
    if (mutation === "capability") profile.scopes[0].capabilities = ["chat.read"];
    if (mutation === "audience") profile.audiences = ["ananta-meet-machine-v1"];
    if (mutation === "window") profile.keys[0].notAfter = f.now / 1000 + 60;
    if (mutation === "material") { profile.keys[0].x = profile.keys[1].x; profile.keys.pop(); }
    assert.equal(f.replace(profile).status, "updated"); assert.equal(f.sessions.live(lease.sessionId), false);
  });
}

test("identical reload preserves inflight verification; a higher revision fences old verification and preserves replay", async t => {
  const f = fixture(t), token = `Bearer ${await f.token()}`;
  const current = f.admission.verify(token, join, f.now);
  assert.equal(f.replace(f.profile).status, "unchanged"); await current;
  f.replace({ ...f.profile, revision: 2 });
  await assert.rejects(f.admission.verify(token, join, f.now), /machine_grant_invalid/);
  const next = f.admission.verify(`Bearer ${await f.token()}`, join, f.now);
  f.replace({ ...f.profile, revision: 3 });
  await assert.rejects(next, /machine_grant_invalid/);
  assert.equal(f.admission.current(await f.verify(), f.now), true);
});

test("invalid, ambiguous and rollback profiles suspend all admission until a higher valid revision", async t => {
  const f = fixture(t);
  for (const invalid of [new Error("private-file-canary"), { ...f.profile, issuer: "https://other.test" },
    { ...f.profile, scopes: [] }, { ...f.profile, revision: 0 }]) {
    assert.deepEqual(f.replace(invalid), { schema: "ananta.meet-trust-reload.v1", status: "blocked" });
    assert.equal(f.admission.enabled, false);
    await assert.rejects(f.verify(), /machine_admission_disabled/);
    assert.equal(f.replace(f.profile).status, "blocked");
  }
  assert.equal(f.replace({ ...f.profile, revision: 2 }).status, "updated");
  assert.equal(f.admission.enabled, true);
  const id = await f.verify(), lease = f.sessions.issue(id, "device");
  f.sessions.attach(lease.sessionId, () => true, () => {}, null, null, () => { throw new Error("private-detach-canary"); });
  assert.equal(f.replace(f.profile).status, "blocked"); assert.equal(f.sessions.live(lease.sessionId), false);
});

test("signal binding is opt-in, reports fixed states and removes only its own listener", () => {
  const signals = new EventEmitter(), server = new EventEmitter(), reports = [];
  let calls = 0;
  const other = () => {}; signals.on("SIGHUP", other);
  bindMachineTrustReload({ server, reloadMachineTrust: null }, signals, value => reports.push(value));
  assert.equal(signals.listenerCount("SIGHUP"), 1);
  bindMachineTrustReload({ server, reloadMachineTrust: () => { calls++; return { status: "updated" }; } }, signals, value => reports.push(value));
  signals.emit("SIGHUP"); assert.equal(calls, 1); assert.deepEqual(reports, [{ status: "updated" }]);
  server.emit("close"); assert.equal(signals.listenerCount("SIGHUP"), 1);
});

test("reload configuration cannot enable inline, legacy, missing or relative trust", () => {
  assert.equal(machineTrustReloadFile({}), "");
  assert.equal(machineTrustReloadFile({ MACHINE_HUB_TRUST_RELOAD: "signal", MACHINE_HUB_TRUST_PROFILE_JSON_FILE: "/public/trust.json" }), "/public/trust.json");
  for (const env of [{ MACHINE_HUB_TRUST_RELOAD: "" }, { MACHINE_HUB_TRUST_RELOAD: "watch" },
    { MACHINE_HUB_TRUST_RELOAD: "signal" }, { MACHINE_HUB_TRUST_RELOAD: "signal", MACHINE_HUB_TRUST_PROFILE_JSON_FILE: "relative" },
    { MACHINE_HUB_TRUST_RELOAD: "signal", MACHINE_HUB_TRUST_PROFILE_JSON_FILE: "/public", MACHINE_HUB_ISSUER: "https://other.test" }]) {
    assert.throws(() => machineTrustReloadFile(env), /machine_trust_reload_config_invalid/);
  }
});
