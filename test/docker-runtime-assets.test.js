import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Angular build stage includes the shared browser-neutral chat modules and declarations", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const buildStage = dockerfile.split(/^FROM node:22-alpine AS build\r?$/m)[1]
    .split(/^FROM /m)[0].split("RUN npm run build")[0];
  const copiedFiles = [...buildStage.matchAll(/^COPY ([^\r\n]+) \.\/src\/\r?$/gm)]
    .flatMap(match => match[1].split(/\s+/));
  for (const name of ["machine-chat-contract", "machine-chat-queue"]) {
    for (const extension of ["js", "d.ts"]) {
      const source = `src/${name}.${extension}`;
      assert.ok(copiedFiles.includes(source), `missing Angular build input: ${source}`);
      await readFile(new URL(`../${source}`, import.meta.url), "utf8");
    }
  }
});

test("runtime image copies every repository asset imported by the Node server", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^COPY src \.\/src$/m);
  assert.match(dockerfile, /^COPY contracts \.\/contracts$/m);
  assert.match(dockerfile, /^COPY --from=build \/app\/dist \.\/dist$/m);
});

test("runtime targets compile only the artifacts they consume", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");

  assert.match(dockerfile, /^FROM golang:1\.24-alpine AS media-agent-artifacts$/m);
  assert.match(dockerfile, /^FROM golang:1\.24-alpine AS native-packager-source$/m);
  assert.match(dockerfile, /^FROM native-packager-source AS native-packager-runtime-build$/m);
  assert.match(dockerfile, /^FROM native-packager-runtime-build AS native-packager-artifacts$/m);
  assert.match(dockerfile, /^FROM golang:1\.24-alpine AS broadcast-origin-build$/m);
  assert.match(
    dockerfile,
    /^COPY --from=broadcast-origin-build \/broadcast-hls-origin \/broadcast-hls-origin$/m,
  );
  assert.match(
    dockerfile,
    /^COPY --from=native-packager-runtime-build \/native-broadcast-packager \/usr\/local\/bin\/native-broadcast-packager$/m,
  );

  const mediaStage = dockerfile.slice(
    dockerfile.indexOf("FROM golang:1.24-alpine AS media-agent-artifacts"),
    dockerfile.indexOf("FROM golang:1.24-alpine AS native-packager-source"),
  );
  assert.doesNotMatch(mediaStage, /native-broadcast-packager|broadcast-hls-origin/);
});
