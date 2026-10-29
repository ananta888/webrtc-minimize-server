import assert from "node:assert/strict";
import test from "node:test";
import { observeNativeSourceAuthority } from "./helpers/native-source-authority-observation.mjs";

function fixture() {
  const writer = { programRevision: 2, sourceAuthorityRevision: 2, expiresAt: Date.now() + 60000,
    state: "live", leaseId: "private-lease", packagerRef: "private-device", programEpoch: 1, fencingRevision: 1 };
  const generation = Object.freeze({ private: "not-exported" });
  const candidate = { online: true, generation, capability: { deviceRef: "private-device", health: "healthy", expiresAt: writer.expiresAt } };
  const publication = { publicationEpoch: 1, source: "microphone" };
  const app = { broadcastRuntime: { nativeSourceWriterContext: () => writer },
    nativePackagers: { sourceContext: () => candidate }, registry: { publication: () => publication } };
  return { app, writer, candidate, publication };
}

test("passive authority reads retain exact return identities and export only bounded metadata", () => {
  const f = fixture(), rows = [], original = f.app.broadcastRuntime.nativeSourceWriterContext;
  const close = observeNativeSourceAuthority(f.app, rows);
  assert.equal(f.app.broadcastRuntime.nativeSourceWriterContext({}, {}, "private-program"), f.writer);
  f.app.nativePackagers.sourceContext({}, "private-device"); f.app.registry.publication({}, "private-publication");
  assert.equal(rows.length, 3); assert.equal(JSON.stringify(rows).includes("private"), false);
  f.writer.sourceAuthorityRevision = 3;
  f.writer.leaseId = "replacement-private-lease";
  f.app.broadcastRuntime.nativeSourceWriterContext({}, {}, "private-program");
  assert.equal(rows.at(-1).authorityRevision, 3);
  assert.equal(rows.at(-1).bindingChanged, true);
  close(); assert.equal(f.app.broadcastRuntime.nativeSourceWriterContext, original);
});

test("denied or malformed observation cannot alter the original result or thrown object", () => {
  const f = fixture(), error = new Error("private details"), rows = [];
  f.app.broadcastRuntime.nativeSourceWriterContext = () => { throw error; };
  const close = observeNativeSourceAuthority(f.app, rows);
  assert.throws(() => f.app.broadcastRuntime.nativeSourceWriterContext({}, {}, "p"), value => value === error);
  assert.deepEqual(rows, [{ port: "writer", available: false, denied: true }]);
  Object.defineProperty(f.publication, "publicationEpoch", { get: () => { throw error; } });
  assert.equal(f.app.registry.publication({}, "p"), f.publication);
  close();
});

test("distinct observation is capped and duplicate reads do not allocate rows", () => {
  const f = fixture(), rows = [], close = observeNativeSourceAuthority(f.app, rows);
  for (let n = 0; n < 100; n++) f.app.registry.publication({}, "p");
  assert.equal(rows.length, 1);
  for (let n = 0; n < 100; n++) {
    f.publication.publicationEpoch++;
    f.app.registry.publication({}, "p");
  }
  assert.equal(rows.length, 64); close();
});
