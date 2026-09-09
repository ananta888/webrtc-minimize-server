import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installRelayInputObservation, observeRelayConsent, relayTopologyObservation } from "./helpers/relay-topology-observation.mjs";

test("serialized browser observer retains only bounded booleans and error enums without changing sends", () => {
  const native = [], failure = new Error("private-native-failure"), window = {};
  let change;
  class Socket {
    listeners = [];
    addEventListener(name, callback) { assert.equal(name, "message"); this.listeners.push(callback); }
    send(value) { if (value === "fail") throw failure; native.push(value); return 7; }
  }
  vm.runInNewContext("(" + installRelayInputObservation.toString() + ")()", {
    window, WebSocket: Socket, document: { addEventListener(name, callback) {
      assert.equal(name, "change"); change = callback;
    } },
  });
  const socket = new Socket();
  for (let n = 0; n < 20; n++) {
    change({ target: { id: "relay-consent", checked: n % 2 === 0 } });
    assert.equal(socket.send(JSON.stringify({ type: "relay-consent", enabled: true })), 7);
    socket.listeners[0]({ data: JSON.stringify({ type: "error", code: n % 2 ? "private-error" : "rate_limited" }) });
  }
  assert.equal(socket.listeners.length, 1); assert.equal(native.length, 20);
  assert.throws(() => socket.send("fail"), error => error === failure);
  const result = JSON.parse(JSON.stringify(window.__relayInputObservation()));
  assert.deepEqual(Object.keys(result).sort(), ["changes", "errors", "sent"]);
  assert.ok(Object.values(result).every(rows => rows.length === 8));
  assert.deepEqual(result.errors.slice(0, 2), ["rate_limited", "other"]);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  result.sent.length = 0; assert.equal(window.__relayInputObservation().sent.length, 8);
});

test("unknown browser fields never cross the failure projection", async () => {
  const browser = page("adaptive_mesh · E1");
  browser.evaluate = async () => ({ changes: [], errors: [], sent: [], secret: "private" });
  assert.deepEqual((await relayTopologyObservation([browser], [])).inputs, [null]);
});

test("consent history preserves native behavior and retains at most sixteen copied fixed entries", () => {
  const peer = { roomId: "private-room" }, result = {}, failure = new Error("private");
  const registry = { members(room) { assert.equal(room, peer.roomId); return [peer]; },
    setRelayConsent(current, enabled, now) {
      assert.equal(this, registry); assert.equal(current, peer); assert.equal(now, 3);
      if (!enabled) throw failure;
      return result;
    } };
  const history = observeRelayConsent(registry);
  for (let n = 0; n < 20; n++) assert.equal(registry.setRelayConsent(peer, true, 3), result);
  assert.equal(history().length, 16); assert.deepEqual(history()[0], { member: 0, enabled: true });
  const copy = history(); copy[0].member = 7; assert.equal(history()[0].member, 0);
  assert.throws(() => registry.setRelayConsent(peer, false, 3), error => error === failure);
  assert.doesNotMatch(JSON.stringify(history()), /private/);
});

function page(text) {
  return { async evaluate() { return null; }, locator(selector) {
    assert.equal(selector, "#topology-status");
    return { async textContent(options) {
      assert.deepEqual(options, { timeout: 1000 });
      if (text instanceof Error) throw text;
      return text;
    } };
  } };
}

test("relay failure projection contains bounded counts and known modes, never raw identities", async () => {
  const result = await relayTopologyObservation([
    page("adaptive_mesh · E3"), page("trusted_peer_relay · E9"), page("private-content"), page(new Error("secret")),
  ], [
    { id: "private-peer", relayConsent: true, relayCapability: { visible: false } },
    { relayConsent: true, relayCapability: { network: "constrained" } },
    { relayConsent: true, relayCapability: { selfCapacity: 20 } },
    { relayConsent: true }, { relayConsent: false },
  ]);
  assert.deepEqual(result, { members: 5, consenting: 4, eligible: 1, hidden: 1, constrained: 1, lowCapacity: 1,
    modes: ["adaptive_mesh", "trusted_peer_relay", "unknown", "unavailable"], inputs: [null, null, null, null] });
  assert.doesNotMatch(JSON.stringify(result), /private|secret/);
});

test("oversized relay observation cannot start browser reads", async () => {
  for (const [pages, members] of [[new Array(21), []], [[], new Array(21)], [null, []]]) {
    await assert.rejects(relayTopologyObservation(pages, members), /observation_bounds/);
  }
});
