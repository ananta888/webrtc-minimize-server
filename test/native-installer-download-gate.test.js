import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { observeNativeInstallerDownload } from "../scripts/native-installer-download-gate.mjs";

function fixture({ status = 201, missingRequest = false, missingResponse = false, failedTransport = "",
  missingDownload = false, ui = [] } = {}) {
  const page = new EventEmitter();
  const request = { method: () => "POST", url: () => "https://webrtc.example/api/native-packagers/enrollments",
    failure: () => ({ errorText: failedTransport }) };
  const response = { request: () => request, status: () => status };
  const download = {};
  let clicks = 0;
  page.waitForResponse = async (matches, options) => {
    assert.equal(options.timeout, 30_000);
    assert.equal(matches(response), true);
    assert.equal(matches({ request: () => ({ ...request, url: () => "https://unrelated.example/api/native-packagers/enrollments" }) }), false);
    if (missingResponse) throw new Error("SECRET-CANARY");
    return response;
  };
  page.waitForEvent = async (event, options) => {
    assert.equal(event, "download"); assert.equal(options.timeout, 30_000);
    if (missingDownload) throw new Error("SECRET-CANARY");
    return download;
  };
  page.locator = selector => selector === "#app-error" ? { allTextContents: async () => ui } : {
    click: async () => { clicks++; if (!missingRequest) page.emit("request", request);
      if (failedTransport) page.emit("requestfailed", request); },
  };
  return { page, response, download, clicks: () => clicks };
}

test("installer observer returns one real response/download without repeating the click", async () => {
  const f = fixture();
  assert.deepEqual(await observeNativeInstallerDownload(f.page, "https://webrtc.example"), { response: f.response, download: f.download });
  assert.equal(f.clicks(), 1);
  assert.equal(f.page.eventNames().length, 0);
});

for (const [label, options, expected] of [
  ["missing request", { missingRequest: true, missingResponse: true }, /phase=response:request=false:http=0/],
  ["HTTP rejection", { status: 401, missingDownload: true }, /phase=response:request=true:http=401/],
  ["browser transport", { missingResponse: true, failedTransport: "net::ERR_NETWORK_CHANGED" }, /transport=net::ERR_NETWORK_CHANGED/],
  ["missing download", { missingDownload: true }, /phase=download:request=true:http=201/],
]) test(`installer observer classifies ${label} and removes listeners`, async () => {
  const f = fixture({ ...options, ui: ["SECRET-CANARY native_packager_installer_failed"] });
  await assert.rejects(observeNativeInstallerDownload(f.page, "https://webrtc.example"), error => {
    assert.match(error.message, expected);
    assert.match(error.message, /native_packager_installer_failed/);
    assert.ok(!error.message.includes("SECRET-CANARY"));
    return true;
  });
  assert.equal(f.clicks(), 1);
  assert.equal(f.page.eventNames().length, 0);
});
