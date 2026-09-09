import assert from "node:assert/strict";
import test from "node:test";
import { bridgeBrowserLauncher } from "./helpers/machine-bridge-browser.mjs";
import { peerBrowserDriver } from "./helpers/machine-peer-driver.mjs";

const input = { engine: "chromium", network: "meet-test-tls-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa-network",
  certificatePath: "/tmp/synthetic-public-certificate.pem", spki: "a".repeat(43) + "=", originHost: "172.30.0.2" };
const endpoint = "ws://172.30.0.3:8099/" + "b".repeat(32);
const response = value => ({ done: false, value: JSON.stringify({ schema: "ananta.meet-test-browser-response.v1", endpoint: value }) });

test("private peer launch has one exact handshake and one owned-network connection", async () => {
  const sent = [], connections = [];
  const launch = bridgeBrowserLauncher({ send: value => sent.push(value), receive: async () => response(endpoint),
    connect: async (...args) => { connections.push(args); return "owned-browser"; } });
  assert.equal(await launch(input), "owned-browser");
  assert.deepEqual(sent, [{ schema: "ananta.meet-test-browser-request.v1", test_network: input.network,
    certificate: input.certificatePath, spki: input.spki }]);
  assert.deepEqual(connections, [[endpoint, { timeout: 15000 }]]);
  await assert.rejects(launch(input), /request_invalid/);
});

for (const bad of ["ws://172.31.0.3:8099/" + "b".repeat(32), "ws://127.0.0.1:8099/" + "b".repeat(32),
  endpoint + "?secret=PRIVATE", endpoint.replace(":8099", ":8080"), endpoint.replace("ws:", "wss:"), "PRIVATE"]) {
  test("rejects a foreign or noncanonical peer endpoint without a connection", async () => {
    let calls = 0;
    const launch = bridgeBrowserLauncher({ send() {}, receive: async () => response(bad), connect: () => calls++ });
    await assert.rejects(launch(input), { message: "test_bridge_browser_unavailable" }); assert.equal(calls, 0);
  });
}

for (const message of [{ done: true }, { done: false, value: "PRIVATE" },
  { done: false, value: '{"schema":"a","schema":"b"}' }]) {
  test("EOF and malformed replies are bounded fixed errors", async () => {
    const launch = bridgeBrowserLauncher({ send() {}, receive: async () => message, connect: assert.fail });
    await assert.rejects(launch(input), { message: "test_bridge_browser_unavailable" });
  });
}

test("no controller response expires without a human or connection", async () => {
  const launch = bridgeBrowserLauncher({ send() {}, receive: () => new Promise(() => {}), connect: assert.fail, timeoutMs: 5 });
  await assert.rejects(launch(input), { message: "test_bridge_browser_unavailable" });
});

test("other engines or missing driver cannot become a silent host-browser fallback", async () => {
  const launch = bridgeBrowserLauncher({ send: assert.fail, receive: assert.fail, connect: assert.fail });
  await assert.rejects(launch({ ...input, engine: "firefox" }), /request_invalid/);
  for (const value of [undefined, "relative", "/definitely-missing/test-driver"]) {
    assert.throws(() => peerBrowserDriver(value), { message: "test_peer_browser_driver_invalid" });
  }
});
