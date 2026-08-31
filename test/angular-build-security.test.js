import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("production Angular styles load without CSP-blocked inline handlers", () => {
  const angular = JSON.parse(readFileSync("angular.json", "utf8"));
  const production = angular.projects["webrtc-client"].architect.build.configurations.production;
  assert.equal(production.optimization.styles.inlineCritical, false);

  const index = readFileSync("dist/browser/index.html", "utf8");
  assert.match(index, /<link rel="stylesheet" href="styles-[A-Z0-9]+\.css">/);
  assert.doesNotMatch(index, /\sonload=/);
});
