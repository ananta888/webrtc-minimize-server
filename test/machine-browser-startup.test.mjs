import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { observeBrowserStartup } from "./helpers/machine-browser-startup.mjs";

test("startup diagnostics retain bounded codes, never URLs, tokens or contents", () => {
  const page = new EventEmitter(), value = observeBrowserStartup(page);
  const secret = "private-chat-token-https://private.example/room-secret";
  for (let n = 0; n < 20; n++) {
    page.emit("response", { status: () => 503, request: () => ({ resourceType: () => "script" }) });
    page.emit("pageerror", { name: "TypeError", message: `NG0200 ${secret}` });
    page.emit("requestfailed", { resourceType: () => "fetch", failure: () => ({ errorText: `net::ERR_FAILED ${secret}` }) });
    page.emit("console", { type: () => "error", text: () => secret });
  }
  for (const list of Object.values(value)) assert.equal(list.length, 8);
  assert.deepEqual(value.script_errors[0], { kind: "TypeError", code: "NG0200" });
  assert.deepEqual(value.failed_requests[0], { type: "fetch", code: "ERR_FAILED" });
  assert.equal(value.console_errors[0], "unclassified");
  assert.equal(JSON.stringify(value).includes("private"), false);
});

test("successful requests are ignored and module MIME failures have a closed code", () => {
  const page = new EventEmitter(), value = observeBrowserStartup(page);
  page.emit("response", { status: () => 200 });
  page.emit("console", { type: () => "log", text: () => "ignored" });
  assert.deepEqual(value.http_errors, []); assert.deepEqual(value.console_errors, []);
  page.emit("console", { type: () => "error", text: () => "Failed to load module script: MIME type mismatch" });
  assert.deepEqual(value.console_errors, ["module_script_mime"]);
});
