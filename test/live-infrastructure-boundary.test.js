import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { forbidLiveCapture, liveJson, liveRequestAllowed } from "../scripts/live-infrastructure-boundary.mjs";

test("live capture fails closed without calling devices or waiting for a person", async () => {
  let deviceCalls = 0;
  const devices = { getUserMedia() { deviceCalls++; }, getDisplayMedia() { deviceCalls++; } };
  const sandbox = vm.createContext({ window: {}, navigator: { mediaDevices: devices } });
  vm.runInContext(`(${forbidLiveCapture.toString()})()`, sandbox);
  for (let index = 0; index < 10; index++) {
    for (const method of ["getUserMedia", "getDisplayMedia"]) {
      await assert.rejects(devices[method](), { message: "live_human_capture_forbidden" });
    }
  }
  assert.equal(deviceCalls, 0);
  assert.equal(sandbox.window.__captureCalls.length, 8);
  assert.throws(() => { devices.getUserMedia = () => {}; }, TypeError);
  vm.runInNewContext(`(${forbidLiveCapture.toString()})()`, { window: {}, navigator: {} });
});

test("live browser requests accept only explicit exact origins", () => {
  const origins = new Set(["https://meet.example", "https://identity.example"]);
  for (const url of ["https://meet.example/login", "https://identity.example/keys"]) {
    assert.equal(liveRequestAllowed(url, origins), true);
  }
  for (const url of ["https://meet.example.evil/", "http://meet.example/", "data:text/plain,test", "/relative", "not a url"]) {
    assert.equal(liveRequestAllowed(url, origins), false);
  }
});

test("bounded discovery reader disables redirects and releases its request", async () => {
  let options;
  const value = await liveJson("https://identity.example/keys", { fetchImpl: async (_, opts) => {
    options = opts;
    return new Response('{"keys":[]}');
  } });
  assert.deepEqual(value, { keys: [] });
  assert.equal(options.redirect, "error");
  assert.equal(options.signal.aborted, true);
});

for (const [label, response] of [
  ["error status", () => new Response("private-token", { status: 401 })],
  ["missing body", () => ({ status: 200 })],
  ["oversized body", () => new Response("x".repeat(65537))],
  ["malformed JSON", () => new Response("private-token")],
  ["invalid UTF-8", () => new Response(Uint8Array.of(0xff))],
]) test(`live discovery rejects ${label} without source content`, async () => {
  await assert.rejects(liveJson("https://identity.example", { fetchImpl: async () => response() }),
    { message: "live_document_unavailable" });
});

test("live discovery bounds both stuck fetch and stuck response body", { timeout: 2000 }, async () => {
  for (const fetchImpl of [
    () => new Promise(() => {}),
    async () => ({ status: 200, body: { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } } }),
    async () => { throw new Error("private-token"); },
  ]) await assert.rejects(liveJson("https://identity.example", { fetchImpl, timeoutMs: 10 }),
    { message: "live_document_unavailable" });
});

test("live discovery validates deadlines before fetching", async () => {
  for (const timeoutMs of [0, -1, 5001, NaN, "10"]) {
    await assert.rejects(liveJson("https://identity.example", {
      timeoutMs, fetchImpl: () => assert.fail("fetch must not start"),
    }), { message: "live_document_unavailable" });
  }
});
