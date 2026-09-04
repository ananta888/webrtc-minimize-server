import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const results = JSON.parse(readFileSync(
  new URL("../infra/testing/broadcast-interop-results.v1.json", import.meta.url),
  "utf8",
));

test("interop evidence names every required platform without promoting unavailable devices", () => {
  assert.equal(results.version, 1);
  assert.deepEqual(results.platforms.map(({ id }) => id), [
    "chromium-linux", "firefox-linux", "edge-desktop", "safari-desktop", "android", "ios",
  ]);
  assert.equal(results.platforms.filter(({ publish }) => publish === "verified").length, 3);
  for (const id of ["safari-desktop", "android", "ios"]) {
    assert.equal(results.platforms.find((platform) => platform.id === id).publish, "unverified");
  }
});

test("real Windows Edge evidence is distinct from bundled Chromium", () => {
  const edge = results.platforms.find(({ id }) => id === "edge-desktop");
  assert.equal(edge.publish, "verified");
  assert.match(edge.engineVersion, /windows/);
  assert.match(edge.evidence, /real Windows Edge/);
});

test("interop evidence keeps providers, WAN and perceptual quality honest", () => {
  assert.equal(results.adapters.find(({ id }) => id === "mediamtx-1.20").status, "verified-local");
  assert.equal(results.adapters.find(({ id }) => id === "moq-draft20").status, "experimental");
  assert.equal(results.networkProfiles.find(({ id }) => id === "mobile-nat-network-switch").status, "unverified");
  assert.equal(results.quality.find(({ id }) => id === "av-caption-sync-text").status, "unverified-physical");
  assert.equal(JSON.stringify(results).includes("production-ready"), false);
});
