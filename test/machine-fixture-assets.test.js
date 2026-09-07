import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { machineFixtureAssets } from "./helpers/machine-fixture-assets.mjs";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { createAppServer } from "../src/server.js";

async function assets(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meet-assets-unit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "index.html"), '<html>isolated-build<script src="main-TEST.js" type="module"></script></html>');
  await fs.writeFile(path.join(root, "main-TEST.js"), "/* isolated current build */");
  return root;
}

test("private fixture keeps default selection and resolves an explicit complete build", async t => {
  assert.equal(await machineFixtureAssets(undefined), undefined);
  const root = await assets(t);
  assert.equal(await machineFixtureAssets(root), await fs.realpath(root));
});

test("selected invalid, missing and partial builds fail closed without path disclosure", async t => {
  const root = await assets(t);
  for (const input of [null, false, {}, "", "dist/browser", path.join(root, "missing"), path.join(root, "index.html")]) {
    await assert.rejects(machineFixtureAssets(input), { message: "test_public_dir_invalid" });
  }
  await fs.unlink(path.join(root, "main-TEST.js"));
  await assert.rejects(machineFixtureAssets(root), { message: "test_public_dir_invalid" });
  for (const html of ['<html>no modules</html>', '<script src="https://example.test/main.js"></script>',
    '<script src="../main.js"></script>', '<script src="/main.js"></script>']) {
    await fs.writeFile(path.join(root, "index.html"), html);
    await assert.rejects(machineFixtureAssets(root), { message: "test_public_dir_invalid" });
  }
});

test("fixture rejects escaped symlink assets and oversized indexes", async t => {
  const root = await assets(t), other = await assets(t);
  await fs.unlink(path.join(root, "main-TEST.js"));
  await fs.symlink(path.join(other, "main-TEST.js"), path.join(root, "main-TEST.js"));
  await assert.rejects(machineFixtureAssets(root), { message: "test_public_dir_invalid" });
  await fs.writeFile(path.join(root, "index.html"), "x".repeat(1024 * 1024 + 1));
  await assert.rejects(machineFixtureAssets(root), { message: "test_public_dir_invalid" });
});

test("invalid explicit selection fails before resource registration or private network startup", async () => {
  const stages = [];
  await assert.rejects(machineBrowserFixture({ after() { throw new Error("resource_registered"); } }, {
    publicDir: "relative-build-is-invalid", tlsPortProxy: true, observeStage: stage => stages.push(stage),
  }), { message: "test_public_dir_invalid" });
  assert.deepEqual(stages, ["test-assets"]);
});

test("test server serves selected index and script, not the default dist", async t => {
  const root = await assets(t);
  const app = createAppServer({ config: { authMode: "disabled", host: "127.0.0.1", port: 0 },
    publicDir: await machineFixtureAssets(root) });
  t.after(async () => {
    await new Promise(resolve => app.webSocketServer.close(resolve));
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const index = await fetch(origin + "/machine");
  assert.equal(index.status, 200);
  assert.match(await index.text(), /isolated-build/);
  const script = await fetch(origin + "/main-TEST.js");
  assert.equal(script.status, 200);
  assert.equal(await script.text(), "/* isolated current build */");
});
