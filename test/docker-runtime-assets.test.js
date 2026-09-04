import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("runtime image copies every repository asset imported by the Node server", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^COPY src \.\/src$/m);
  assert.match(dockerfile, /^COPY contracts \.\/contracts$/m);
  assert.match(dockerfile, /^COPY --from=build \/app\/dist \.\/dist$/m);
});
