import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installMachineForcedRelay } from "./helpers/machine-forced-relay.js";

const url = "turn:172.30.0.4:3478?transport=tcp";
const server = () => ({ urls: [url], username: "1900000000:" + "a".repeat(20), credential: "A".repeat(27) + "=", credentialType: "password" });
function fixture() {
  let body = { icePolicy: { version: 1, infrastructureRelayIceServers: [server()] } }, status = 201;
  const calls = [], connections = [], diagnostics = [];
  class Peer extends EventTarget {
    constructor(config) { super(); this.config = config; connections.push(this); }
    setConfiguration(config) { this.config = config; }
  }
  const context = vm.createContext({ URL, location: { href: "https://meet.example.test/machine", origin: "https://meet.example.test" },
    console: { debug: value => diagnostics.push(value) },
    RTCPeerConnection: Peer, fetch: async (...args) => {
      calls.push(args); return new Response(JSON.stringify(body), { status });
    } });
  vm.runInContext(`(${installMachineForcedRelay.toString()})(${JSON.stringify(url)})`, context);
  return { context, calls, connections, diagnostics, set(value, code = 201) { body = value; status = code; },
    join: () => context.fetch("/api/machine/sessions", { method: "POST", body: "synthetic-device-proof" }),
    create: () => new context.RTCPeerConnection({ iceServers: [], iceTransportPolicy: "all" }) };
}
test("forced relay uses only the actual session response and retains its transport constraint on updates", async () => {
  const f = fixture(); assert.throws(() => f.create(), /session_required/);
  const response = await f.join();
  assert.equal(f.calls.length, 1); assert.equal(response.status, 201);
  assert.equal((await response.json()).icePolicy.version, 1, "original response remains readable");
  const pc = f.create();
  assert.equal(pc.config.iceTransportPolicy, "relay");
  assert.deepEqual(JSON.parse(JSON.stringify(pc.config.iceServers)), [server()]);
  pc.setConfiguration({ iceServers: [{ urls: "stun:elsewhere.test" }], iceTransportPolicy: "all" });
  assert.deepEqual(JSON.parse(JSON.stringify(pc.config.iceServers)), [server()]);
  assert.equal(pc.config.iceTransportPolicy, "relay");
  assert.equal(f.calls.length, 1, "no credential fetch or hidden admission request");
});
test("relay failure observation contains at most eight numeric codes and no private error contents", async () => {
  const f = fixture(); await f.join(); const pc = f.create();
  for (const errorCode of [undefined, 1000, "486", ...Array(20).fill(486)])
    pc.dispatchEvent(Object.assign(new Event("icecandidateerror"), { errorCode,
      errorText: "private-secret-canary", url: "turn:private-secret-canary" }));
  assert.deepEqual(f.diagnostics, Array(8).fill("test_relay_ice_error:486"));
  assert.equal(f.calls.length, 1);
});
test("public config, another origin and GET do not authorize a test relay connection", async () => {
  for (const [input, method] of [["/config", "GET"], ["https://other.test/api/sessions", "POST"], ["/api/sessions", "GET"]]) {
    const f = fixture(); await f.context.fetch(input, { method });
    assert.throws(() => f.create(), /session_required/);
  }
});
test("invalid or denied new session cannot retain an earlier authorization for a new connection", async () => {
  for (const body of [{}, { icePolicy: { version: 2, infrastructureRelayIceServers: [server()] } },
    { icePolicy: { version: 1, infrastructureRelayIceServers: [server(), server()] } },
    ...[{ urls: ["turn:elsewhere.test"] }, { username: "static" }, { credential: "static" }, { unknown: true }]
      .map(patch => ({ icePolicy: { version: 1, infrastructureRelayIceServers: [{ ...server(), ...patch }] } }))]) {
    const f = fixture(); await f.join(); f.set(body);
    await assert.rejects(f.join(), /session_invalid/); assert.throws(() => f.create(), /session_required/);
  }
  const f = fixture(); await f.join(); f.set({}, 403);
  assert.equal((await f.join()).status, 403); assert.throws(() => f.create(), /session_required/);
});
