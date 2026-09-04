import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("production deployment policy is default-deny, hardened and rollback-gated", () => {
  assert.match(execFileSync(process.execPath, ["scripts/validate-production-deployment.mjs"], {
    encoding: "utf8",
  }), /Validated production deployment/);
});

test("production configs contain no literal credential and expose no gateway admin port", () => {
  const combined = [
    read("infra/deployment/compose.production.yaml"),
    read("infra/deployment/production-policy.v1.json"),
    read("infra/deployment/port-firewall-matrix.v1.json"),
  ].join("\n");
  assert.doesNotMatch(combined, /(?:password|token|privateKey)\s*["':=]+\s*[A-Za-z0-9+/]{16}/i);
  const matrix = JSON.parse(read("infra/deployment/port-firewall-matrix.v1.json"));
  assert.equal(matrix.entries.filter((entry) => entry.public).every(({ component }) => (
    new Set(["caddy", "coturn", "moq"]).has(component)
  )), true);
  assert.equal(matrix.entries.find(({ component }) => component === "mediamtx-admin").public, false);
});
