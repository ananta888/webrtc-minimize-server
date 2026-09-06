import fs from "node:fs";

// A Windows checkout must still generate executable POSIX line endings.
const body = fs.readFileSync(new URL("./native-packager-linux-maintenance.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const quote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;

// Inputs originate in the validated installer contract, never a remote command.
export function linuxPackagerUpdater({ enrollment, artifactUrl, controlUrl, stunUrls }) {
  return ["#!/bin/sh", "set -eu", "umask 077",
    `packager_id=${quote(enrollment.packagerId)}`,
    `artifact_url=${quote(artifactUrl)}`,
    `export NATIVE_PACKAGER_CONTROL_URL=${quote(controlUrl)}`,
    `export NATIVE_PACKAGER_ID=${quote(enrollment.packagerId)}`,
    `export NATIVE_PACKAGER_STUN_URLS=${quote(stunUrls.join(","))}`,
    "unset NATIVE_PACKAGER_ENROLLMENT_TOKEN", body].join("\n");
}
