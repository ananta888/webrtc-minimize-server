import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { JSDOM } from "jsdom";
import { observeBrowserStartup, observeMachinePermissionUi } from "./helpers/machine-browser-startup.mjs";

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

test("permission diagnostics distinguish inactive navigation, absent panel and empty machine list", () => {
  const dom = new JSDOM("<main></main>"), document = dom.window.document;
  try {
    assert.deepEqual(observeMachinePermissionUi(document), { analysisActive: false, panelPresent: false,
      choices: 0, empty: false, signalingConnected: false });
    document.body.innerHTML = '<button id="mesh-analysis-navigation" aria-current="page"></button>'
      + '<div id="connection-status">Signaling verbunden</div>'
      + '<app-machine-permissions-panel><p>Zurzeit ist keine KI im Raum verbunden.</p></app-machine-permissions-panel>';
    assert.deepEqual(observeMachinePermissionUi(document), { analysisActive: true, panelPresent: true,
      choices: 0, empty: true, signalingConnected: true });
  } finally { dom.window.close(); }
});

test("permission diagnostics clamp counts and never return private DOM content or attributes", () => {
  const secret = "private-token-name-room-url";
  const dom = new JSDOM(`<app-machine-permissions-panel data-peer="${secret}"><h3>${secret}</h3>`
    + '<button>Für diese KI einstellen</button>'.repeat(25) + `<p>${secret}</p></app-machine-permissions-panel>`);
  try {
    const before = dom.window.document.body.innerHTML, result = observeMachinePermissionUi(dom.window.document);
    assert.deepEqual(result, { analysisActive: false, panelPresent: true, choices: 20, empty: false, signalingConnected: false });
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(dom.window.document.body.innerHTML, before);
  } finally { dom.window.close(); }
});
