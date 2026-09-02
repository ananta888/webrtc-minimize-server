import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const EXPECTED_PACKAGE_VERSION = "0.0.8";
const EXPECTED_WORKER_SHA256 = "7ba6b482f49ff3d49290b85f4ca13d5c6a5787b237cac1c6d15129668d36f529";
const require = createRequire(import.meta.url);
const bundlePath = require.resolve("vosk-browser");
const packagePath = path.resolve(path.dirname(bundlePath), "../package.json");
const packageMetadata = JSON.parse(await fs.readFile(packagePath, "utf8"));
if (packageMetadata.version !== EXPECTED_PACKAGE_VERSION) {
  throw new Error(`Expected vosk-browser ${EXPECTED_PACKAGE_VERSION}, found ${packageMetadata.version}`);
}

const bundle = await fs.readFile(bundlePath, "utf8");
const match = bundle.match(/createBase64WorkerFactory\('([A-Za-z0-9+/=]+)',\s*null,\s*false\)/);
if (!match) throw new Error("Could not locate the embedded vosk-browser worker");
const upstreamWorker = Buffer.from(match[1], "base64");
const digest = crypto.createHash("sha256").update(upstreamWorker).digest("hex");
if (digest !== EXPECTED_WORKER_SHA256) {
  throw new Error(`Unexpected vosk-browser worker digest ${digest}`);
}
if (!upstreamWorker.includes(Buffer.from("new RecognizerWorker()"))) {
  throw new Error("Extracted vosk-browser worker is missing its entry point");
}

let workerSource = upstreamWorker.toString("utf8");
function replaceOnce(search, replacement) {
  const start = workerSource.indexOf(search);
  if (start < 0 || workerSource.indexOf(search, start + search.length) >= 0) {
    throw new Error(`Expected exactly one vosk-worker fragment: ${search}`);
  }
  workerSource = workerSource.replace(search, replacement);
}

// Upstream mounts IDBFS and otherwise leaves extracted models outside the app's
// visible cache lifecycle. Keep the worker filesystem ephemeral so the explicit
// Cache Storage controls are the only persistent model copies.
replaceOnce('this.logger.verbose("Setting up persistent storage at " + storagePath);', 'this.logger.verbose("Setting up isolated in-memory storage at " + storagePath);');
replaceOnce("this.Vosk.FS.mount(this.Vosk.IDBFS, {}, storagePath);", "// Persistent IDBFS intentionally disabled by the application build.");
replaceOnce("return this.Vosk.syncFilesystem(true);", "return undefined;");
replaceOnce('this.logger.verbose(`Syncing filesystem`);', 'this.logger.verbose(`Keeping extracted model in worker memory`);');
replaceOnce("return this.Vosk.syncFilesystem(false);", "return undefined;");
const worker = Buffer.from(`/* Generated from pinned vosk-browser ${EXPECTED_PACKAGE_VERSION}; IDBFS disabled. */\n${workerSource}`);

const outputPath = path.resolve("dist/browser/assets/vosk-worker.js");
const licenseSourcePath = path.resolve("third_party/vosk-browser/LICENSE");
const licenseOutputPath = path.resolve("dist/browser/assets/vosk-worker.LICENSE.txt");
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, worker);
await fs.copyFile(licenseSourcePath, licenseOutputPath);
console.log(`Extracted isolated pinned vosk-browser worker (${worker.length} bytes)`);
