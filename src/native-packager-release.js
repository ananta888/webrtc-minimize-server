import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RELEASE_FILENAME = "native-packager-release.v1.json";
export const RELEASE_MAX_BYTES = 32_768;
export const RELEASE_REPOSITORY = "ananta888/webrtc-minimize-server";
export const RELEASE_WORKFLOW = `${RELEASE_REPOSITORY}/.github/workflows/ci.yml`;
export const RELEASE_TARGETS = Object.freeze(["linux-amd64", "linux-arm64", "macos-amd64", "macos-arm64", "windows-amd64"]);
export const artifactFilename = id => `native-broadcast-packager-${id}${id === "windows-amd64" ? ".exe" : ""}`;

function closed(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function validateNativePackagerRelease(value) {
  if (!closed(value, ["version", "type", "repository", "workflow", "revision", "builtAt", "agentVersion", "goVersion", "artifacts"])
    || value.version !== 1 || value.type !== "native-packager-release"
    || value.repository !== RELEASE_REPOSITORY || value.workflow !== RELEASE_WORKFLOW
    || typeof value.revision !== "string" || !/^[a-f0-9]{40}$/.test(value.revision)
    || typeof value.builtAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.builtAt)
    || !Number.isFinite(Date.parse(value.builtAt)) || new Date(value.builtAt).toISOString() !== value.builtAt.replace("Z", ".000Z")
    || typeof value.agentVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(value.agentVersion) || value.agentVersion.length > 32
    || typeof value.goVersion !== "string" || !/^go\d+\.\d+\.\d+$/.test(value.goVersion) || value.goVersion.length > 32
    || !Array.isArray(value.artifacts) || value.artifacts.length !== RELEASE_TARGETS.length) throw new Error("native_packager_release_invalid");
  value.artifacts.forEach((artifact, index) => {
    if (!closed(artifact, ["target", "filename", "sha256", "bytes"])
      || artifact.target !== RELEASE_TARGETS[index] || artifact.filename !== artifactFilename(artifact.target)
      || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 134_217_728) throw new Error("native_packager_release_invalid");
    Object.freeze(artifact);
  });
  Object.freeze(value.artifacts);
  return Object.freeze(value);
}

export function buildNativePackagerRelease(directory, build) {
  const artifacts = RELEASE_TARGETS.map(target => {
    const filename = artifactFilename(target), file = path.join(directory, filename);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > 134_217_728) throw new Error("native_packager_artifact_invalid");
    return { target, filename, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), bytes: stat.size };
  });
  const manifest = validateNativePackagerRelease({ version: 1, type: "native-packager-release", repository: RELEASE_REPOSITORY,
    workflow: RELEASE_WORKFLOW, revision: build.revision, builtAt: build.builtAt,
    agentVersion: build.agentVersion, goVersion: build.goVersion, artifacts });
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

export function readNativePackagerRelease(directory, artifactFor) {
  const fd = fs.openSync(path.join(directory, RELEASE_FILENAME), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > RELEASE_MAX_BYTES) throw new Error("native_packager_release_invalid");
    const bytes = Buffer.alloc(RELEASE_MAX_BYTES + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== stat.size) throw new Error("native_packager_release_invalid");
    const body = bytes.subarray(0, count);
    const manifest = validateNativePackagerRelease(JSON.parse(body.toString("utf8")));
    for (const artifact of manifest.artifacts) {
      const actual = artifactFor(artifact.target);
      if (actual.sha256 !== artifact.sha256 || actual.size !== artifact.bytes || actual.artifact !== artifact.filename) throw new Error("native_packager_release_mismatch");
    }
    return { body, manifest };
  } finally { fs.closeSync(fd); }
}
