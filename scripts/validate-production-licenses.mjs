import { existsSync, readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
const allowed = new Set(["MIT", "BSD-3-Clause", "Apache-2.0"]);
const observed = new Map();

for (const [path, metadata] of Object.entries(lock.packages || {})) {
  if (!path.startsWith("node_modules/") || metadata.dev === true) continue;
  const manifestPath = new URL(`../${path}/package.json`, import.meta.url);
  if (!existsSync(manifestPath)) throw new Error(`production dependency is not installed: ${path}`);
  const manifest = JSON.parse(readFileSync(manifestPath));
  const license = Array.isArray(manifest.license) ? manifest.license.join(" OR ") : manifest.license;
  if (!allowed.has(license)) throw new Error(`unreviewed production license: ${manifest.name}@${manifest.version}:${license || "missing"}`);
  observed.set(`${manifest.name}@${manifest.version}`, license);
}

if (observed.size < 4) throw new Error("production dependency license inventory is unexpectedly small");
process.stdout.write(`Validated ${observed.size} production dependency licenses: ${[...new Set(observed.values())].sort().join(", ")}.\n`);
