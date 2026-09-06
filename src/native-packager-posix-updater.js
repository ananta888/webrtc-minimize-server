import fs from "node:fs";

const read = name => fs.readFileSync(new URL(name, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const body = read("./native-packager-posix-maintenance.sh");
const adapters = Object.freeze({ linux: read("./native-packager-linux-maintenance.sh"), macos: read("./native-packager-macos-maintenance.sh") });
const bounded = read("./native-packager-bounded-command.pl");
const quote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;

export function posixPackagerUpdater({ platform, enrollment, artifactUrl, controlUrl, stunUrls }) {
  if (!Object.hasOwn(adapters, platform)) throw new Error("Unsupported POSIX maintenance platform");
  return ["#!/bin/sh", "set -eu", "umask 077",
    `packager_id=${quote(enrollment.packagerId)}`, `artifact_url=${quote(artifactUrl)}`,
    `export NATIVE_PACKAGER_CONTROL_URL=${quote(controlUrl)}`, `export NATIVE_PACKAGER_ID=${quote(enrollment.packagerId)}`,
    `export NATIVE_PACKAGER_STUN_URLS=${quote(stunUrls.join(","))}`, "unset NATIVE_PACKAGER_ENROLLMENT_TOKEN",
    ...(platform === "macos" ? [`bounded() { perl -e ${quote(bounded)} "$@"; }`] : []),
    adapters[platform], body].join("\n");
}
