import fs from "node:fs";

const body = fs.readFileSync(new URL("./native-packager-windows-maintenance.ps1", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

// Values come only from the validated per-device installer contract.
export function windowsPackagerUpdater({ enrollment, artifactUrl, controlUrl, stunUrls }) {
  return ["param([string]$Action, [string]$ExpectedSha256)", "$ErrorActionPreference = 'Stop'",
    `$packagerId = ${quote(enrollment.packagerId)}`,
    `$artifactUrl = ${quote(artifactUrl)}`,
    `$env:NATIVE_PACKAGER_CONTROL_URL = ${quote(controlUrl)}`,
    `$env:NATIVE_PACKAGER_ID = ${quote(enrollment.packagerId)}`,
    `$env:NATIVE_PACKAGER_STUN_URLS = ${quote(stunUrls.join(","))}`,
    "Remove-Item Env:NATIVE_PACKAGER_ENROLLMENT_TOKEN -ErrorAction SilentlyContinue", body].join("\n");
}
