import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NativePackagerInstallerService } from "../src/native-packager-installers.js";

const ARTIFACTS = [
  "native-broadcast-packager-linux-amd64",
  "native-broadcast-packager-linux-arm64",
  "native-broadcast-packager-macos-amd64",
  "native-broadcast-packager-macos-arm64",
  "native-broadcast-packager-windows-amd64.exe",
];

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-packager-installers-"));
  for (const artifact of ARTIFACTS) fs.writeFileSync(path.join(directory, artifact), `binary:${artifact}`);
  return { directory, service: new NativePackagerInstallerService({ directory }) };
}

function enrollment(platform) {
  return { packagerId: "pkr_0123456789abcdef", enrollmentToken: "A".repeat(43), platform };
}

test("native packager POSIX installer is checksum-bound, outbound-only and sandboxed", (context) => {
  const { directory, service } = fixture();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const installer = service.installer({ enrollment: enrollment("linux"), targetId: "linux-amd64", publicOrigin: "https://webrtc.example" });
  execFileSync("sh", ["-n", "-c", installer.content]);
  assert.match(installer.content, /wss:\/\/webrtc\.example\/native-packager/);
  assert.match(installer.content, /Get-FileHash|sha256sum/);
  assert.match(installer.content, /NoNewPrivileges=true/);
  assert.match(installer.content, /ProtectSystem=strict/);
  assert.match(installer.content, /keinen eingehenden Port/);
  assert.match(installer.content, /uninstall-pkr_/);
  assert.doesNotMatch(installer.content, /listen|firewall-cmd|ufw/);
});

test("native packager Windows installer has checksum, enrollment cleanup and no firewall mutation", (context) => {
  const { directory, service } = fixture();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const installer = service.installer({ enrollment: enrollment("windows"), targetId: "windows-amd64", publicOrigin: "https://webrtc.example" });
  assert.match(installer.content, /Get-FileHash -Algorithm SHA256/);
  assert.match(installer.content, /Remove-Item Env:NATIVE_PACKAGER_ENROLLMENT_TOKEN/);
  assert.match(installer.content, /Startup/);
  assert.doesNotMatch(installer.content, /New-NetFirewallRule/);
  assert.throws(() => service.artifact("../secret"), /artifact_unavailable/);
});
