import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { createAppServer } from "../src/server.js";

const ENV = { AUTH_MODE: "disabled", PAIR_WORKSPACE_ENABLED: "false" };

async function listen(t, env) {
  const app = createAppServer({ env: { ...ENV, ...env } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  return app;
}

test("idle keep-alive sockets outlive Caddy's 2 min upstream idle timeout", async t => {
  const { server } = await listen(t, {});
  assert.equal(server.keepAliveTimeout, 130_000);
  assert.ok(server.headersTimeout > server.keepAliveTimeout);
});

test("HTTP_KEEP_ALIVE_TIMEOUT_MS is bounded", () => {
  assert.equal(loadConfig({ HTTP_KEEP_ALIVE_TIMEOUT_MS: "65000" }).httpKeepAliveTimeoutMs, 65_000);
  for (const value of ["4999", "600001", "1.5", "x"]) {
    assert.throws(() => loadConfig({ HTTP_KEEP_ALIVE_TIMEOUT_MS: value }), /HTTP_KEEP_ALIVE_TIMEOUT_MS/);
  }
});

test("a reused connection is still open after Node's default 5 s idle timeout plus 1 s buffer", async t => {
  const { server } = await listen(t, {});
  const socket = net.connect(server.address().port, "127.0.0.1");
  t.after(() => socket.destroy());
  let closed = false;
  socket.on("close", () => { closed = true; });
  const request = "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n";
  const firstResponse = new Promise(resolve => socket.once("data", resolve));
  socket.write(request);
  assert.match(String(await firstResponse), /^HTTP\/1\.1 /);
  await new Promise(resolve => setTimeout(resolve, 7_500));
  assert.equal(closed, false, "server must not close the idle keep-alive socket");
  const secondResponse = new Promise(resolve => socket.once("data", resolve));
  socket.write(request);
  assert.match(String(await secondResponse), /^HTTP\/1\.1 /);
});
