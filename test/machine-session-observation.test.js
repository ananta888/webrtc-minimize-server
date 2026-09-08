import assert from "node:assert/strict";
import test from "node:test";
import { RoomRegistry } from "../src/room-registry.js";
import { machineSessionObservation } from "../src/machine-session-observation.js";
import { MachineSessionLeases } from "../src/machine-session-leases.js";

function fixture() {
  const registry = new RoomRegistry();
  const peer = registry.join("room-0123456789abcdef01", {}, "Ananta (KI)", 1000,
    { machine: true, machineReceiveVersion: 1, machineCapabilities: ["screen.publish", "avatar.publish"] }).peer;
  return { registry, peer, observe: () => machineSessionObservation(peer, 1) };
}

test("own publication revision observes start, no-op, replacement and stop without content", () => {
  const { registry, peer, observe } = fixture();
  assert.deepEqual(observe().publications, []); assert.equal(observe().publicationRevision, 0);
  const announce = id => registry.setMediaState(peer, { source: "screen", active: true, trackId: id });
  announce("one"); const first = observe(); announce("one");
  assert.equal(observe().publicationRevision, 1); assert.equal(first.publications[0].publicationEpoch, 1);
  announce("two"); assert.equal(observe().publicationRevision, 2);
  assert.deepEqual(observe().publications, [{ publicationId: "two", source: "screen", publicationEpoch: 2 }]);
  registry.setMediaState(peer, { source: "screen", active: false });
  assert.equal(observe().publicationRevision, 3); assert.deepEqual(observe().publications, []);
  registry.setMediaState(peer, { source: "screen", active: false }); assert.equal(observe().publicationRevision, 3);
  announce("two"); assert.equal(observe().publicationRevision, 4); assert.equal(observe().publications[0].publicationEpoch, 3);
  assert.equal(Object.isFrozen(first.publications), true); assert.equal(Object.isFrozen(first.publications[0]), true);
  assert.deepEqual(first.publications, [{ publicationId: "one", source: "screen", publicationEpoch: 1 }]);
});

test("both exhausted counters fail before deleting or replacing the existing source", () => {
  for (const counter of ["publicationRevision", "publicationEpoch"]) {
    const { registry, peer } = fixture();
    registry.setMediaState(peer, { source: "screen", active: true, trackId: "one" });
    peer[counter] = Number.MAX_SAFE_INTEGER;
    assert.throws(() => registry.setMediaState(peer, { source: "screen", active: true, trackId: "two" }), /exhausted/);
    assert.equal(peer.publications.size, 1); assert.equal(peer.publications.has("one"), true);
    registry.setMediaState(peer, { source: "screen", active: true, trackId: "one" });
    assert.equal(peer[counter], Number.MAX_SAFE_INTEGER);
  }
});

test("closed projection rejects human, undeclared source, oversized and mutated metadata", () => {
  const mutations = [p => { p.machine = false; }, p => { p.publicationRevision = NaN; },
    p => { p.publicationRevision = -1; }, p => { p.machineCapabilities = []; },
    p => { p.publications.set("one", { publicationId: "one", source: "screen", publicationEpoch: 1, text: "private" }); },
    p => { p.publications.set("one", { publicationId: "one", source: "__proto__", publicationEpoch: 1 }); },
    p => { p.publications.set("one", { publicationId: "other", source: "screen", publicationEpoch: 1 }); },
    p => { p.publications.set("two", { publicationId: "two", source: "screen", publicationEpoch: 1 }); },
    p => { for (let i = 0; i < 5; i++) p.publications.set(String(i), {}); }];
  for (const mutate of mutations) {
    const { registry, peer, observe } = fixture();
    registry.setMediaState(peer, { source: "screen", active: true, trackId: "one" }); mutate(peer);
    assert.throws(observe, /^Error: machine_observation_state_invalid$/);
  }
});

test("observation uses a separate current lease port and cannot expand its exact scope", t => {
  const leases = new MachineSessionLeases({ clock: () => 1000 }); t.after(() => leases.destroy());
  const identity = { machineExpiresAt: 120000, machineBinding: { issuer: "issuer", subject: "machine:ananta",
    roomId: "room", taskId: "task", tenantId: "tenant", projectId: "project", protocolVersion: "v2",
    runtimeId: "runtime", hubSessionId: "hub", capabilitySet: "screen.publish" } };
  const lease = leases.issue(identity, "device"); let live = true, duringRead = false, reads = 0;
  leases.attach(lease.sessionId, () => live, () => {}, () => ({ legacy: true }), () => {
    reads++; if (duringRead) live = false; return { publicationRevision: 0, publications: [] };
  });
  const observe = (who = identity) => leases.observation(lease.sessionId, who, "a".repeat(32));
  assert.equal(observe().schema, "ananta.meet-session-observation.v1");
  const legacy = leases.authorization(lease.sessionId, identity, "b".repeat(32));
  assert.equal(legacy.schema, "ananta.meet-authorization.v1"); assert.equal(legacy.publicationRevision, undefined);
  for (const key of Object.keys(identity.machineBinding)) {
    assert.throws(() => observe({ ...identity, machineBinding: { ...identity.machineBinding, [key]: "foreign" } }), /scope_invalid/);
  }
  assert.equal(reads, 1); duringRead = true; assert.throws(observe, /unavailable/); assert.throws(observe, /unavailable/);
  assert.equal(reads, 2);
});
