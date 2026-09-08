import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const smoke = new URL("../scripts/production-smoke-gate.mjs", import.meta.url).href;
const fixture = `
const origin = 'https://synthetic-smoke.example.test';
globalThis.fetch = async url => {
  const path = new URL(url).pathname;
  const routes = {
    '/healthz': {status:'ok',rooms:0,participants:0},
    '/readyz': {status:'ok',controlPlane:'ready',broadcast:'disabled'},
    '/config': {auth:{mode:'required'},mediaE2ee:{mode:'required'},maxRoomParticipants:20,
      broadcast:{whip:{enabled:false}},nativePackagers:{publicationEnabled:false}},
    '/api/machine/capabilities': {schema:'ananta.meet-capabilities.v1',
      admissionEnabled: process.env.SMOKE_FIXTURE_ACTUAL === 'enabled'},
  };
  if (path === '/api/machine/capabilities' && process.env.SMOKE_FIXTURE_ACTUAL === 'missing') throw new Error('unsupported machine endpoint');
  const response = new Response(path === '/' ? '<app-root></app-root>' : JSON.stringify(routes[path]),
    {headers:{'content-security-policy': "default-src 'self'"}});
  Object.defineProperty(response, 'url', {value:origin+path});
  return response;
};
await import(${JSON.stringify(smoke)});
`;
for (const expected of ["enabled", "disabled"]) {
  test(`external smoke verifies expected machine admission=${expected} rather than health alone`, () => {
    for (const actual of ["enabled", "disabled", "missing"]) {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", fixture], {
        env: { ...process.env, PRODUCTION_ORIGIN: "https://synthetic-smoke.example.test", EXPECT_NATIVE_BROADCAST: "disabled",
          EXPECT_MACHINE_ADMISSION: expected, SMOKE_FIXTURE_ACTUAL: actual }, encoding: "utf8", timeout: 3000,
      });
      assert.equal(result.status === 0, actual === expected);
      if (actual === expected) assert.equal(JSON.parse(result.stdout).status, "ok");
    }
  });
}
