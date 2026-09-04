import { existsSync, readFileSync } from "node:fs";

import { scanPathsForCanaries } from "./leakage-canary-scanner.mjs";

const coverage = JSON.parse(readFileSync(new URL(
  "../infra/testing/broadcast-security-coverage.v1.json",
  import.meta.url,
), "utf8"));
if (coverage.version !== 1 || !Array.isArray(coverage.suites) || coverage.suites.length < 10) {
  throw new Error("invalid broadcast security coverage matrix");
}
const areas = new Set();
for (const suite of coverage.suites) {
  if (!suite.area || areas.has(suite.area) || suite.positive !== true || !Array.isArray(suite.files)) {
    throw new Error("invalid broadcast security coverage suite");
  }
  areas.add(suite.area);
  for (const file of suite.files) {
    if (!existsSync(file)) throw new Error(`missing broadcast security test: ${file}`);
  }
}

const paths = ["dist/browser"];
for (const optional of ["media-agent-downloads"]) if (existsSync(optional)) paths.push(optional);
const imageArchive = process.env.BROADCAST_IMAGE_ARCHIVE;
if (imageArchive) {
  if (!existsSync(imageArchive)) throw new Error("BROADCAST_IMAGE_ARCHIVE does not exist");
  paths.push(imageArchive);
} else {
  process.stdout.write("SKIP container-image canary scan: set BROADCAST_IMAGE_ARCHIVE to a docker save archive\n");
}
const result = await scanPathsForCanaries(paths);
process.stdout.write(`Broadcast leakage scan passed for ${result.files} files and ${result.bytes} bytes.\n`);
