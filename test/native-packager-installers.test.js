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

function fixture(binary) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-packager-installers-"));
  for (const artifact of ARTIFACTS) fs.writeFileSync(path.join(directory, artifact), binary ?? `binary:${artifact}`);
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
  assert.match(installer.content, /\$root = Join-Path \$base 'pkr_0123456789abcdef'/);
  assert.match(installer.content, /NativePackager\\pkr_0123456789abcdef\\native-broadcast-packager\.exe/);
  assert.match(installer.content, /NativePackager\\pkr_0123456789abcdef\\identity-pkr_/);
  assert.match(installer.content, /NativePackager\\pkr_0123456789abcdef\\run-pkr_/);
  assert.match(installer.content, /ReparsePoint/);
  assert.match(installer.content, /Test-Path -LiteralPath \$root/);
  assert.match(installer.content, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(installer.content, /uninstall-pkr_0123456789abcdef\.ps1/);
  assert.match(installer.content, /StringComparison\]::OrdinalIgnoreCase/);
  assert.match(installer.content, /\.running\.lock/);
  const updater = /\$updaterContent = @'\r?\n([\s\S]*?)\r?\n'@/.exec(installer.content)?.[1];
  assert.ok(updater);
  assert.match(updater, /File\]::Replace\(\$candidateFile,\$binary,\[NullString\]::Value\)/);
  assert.match(updater, /\.maintenance\.lock/);
  assert.match(updater, /Interrupted transaction exists; use recover/);
  assert.match(updater, /134217728/);
  assert.match(updater, /\$request.AllowAutoRedirect = \$false/);
  assert.match(updater, /NativePackager/);
  assert.doesNotMatch(updater, new RegExp("A".repeat(43)));
  assert.doesNotMatch(installer.content, /Stop-Process -Name|taskkill|New-NetFirewallRule/);
  assert.doesNotMatch(installer.content, /New-NetFirewallRule/);
  assert.throws(() => service.artifact("../secret"), /artifact_unavailable/);
});

function lifecycleFixture(context) {
  const { directory, service } = fixture(`#!/bin/sh
set -eu
if [ "\${1:-}" = enroll ]; then
  printf '%s' "$NATIVE_PACKAGER_ID" > "$NATIVE_PACKAGER_IDENTITY_FILE"
else
  printf '%s' "$NATIVE_PACKAGER_ID" >> "$INSTALLER_TEST_RUNS"
fi
`);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const userDirectory = path.join(directory, "isolated user & space");
  const commands = path.join(directory, "commands");
  fs.mkdirSync(userDirectory);
  fs.mkdirSync(commands);
  const command = (name, content) => fs.writeFileSync(path.join(commands, name), `#!/bin/sh\nset -eu\n${content}\n`, { mode: 0o700 });
  command("ffmpeg", "exit 0");
  command("curl", `while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then shift; destination="$1"; fi
  shift
done
cp "$INSTALLER_TEST_ARTIFACT" "$destination"`);
  const controller = `printf '%s\\n' "$*" >> "$INSTALLER_TEST_SERVICE_LOG"
case "$*" in *disable*|*bootout*) [ "\${INSTALLER_TEST_STOP_FAIL:-0}" != 1 ] ;; esac`;
  command("systemctl", controller);
  command("launchctl", controller);
  const env = { ...process.env, HOME: userDirectory, PATH: `${commands}:${process.env.PATH}`,
    INSTALLER_TEST_ARTIFACT: path.join(directory, ARTIFACTS[0]),
    INSTALLER_TEST_RUNS: path.join(directory, "runs"),
    INSTALLER_TEST_SERVICE_LOG: path.join(directory, "services") };
  const run = (content, extraEnv = {}) => execFileSync("sh", ["-c", content], {
    env: { ...env, ...extraEnv }, stdio: "pipe", timeout: 10_000,
  });
  const install = (id, platform = "linux") => service.installer({
    enrollment: { ...enrollment(platform), packagerId: id }, targetId: `${platform}-amd64`, publicOrigin: "https://webrtc.example",
  }).content;
  const base = path.join(userDirectory, ".local/share/ananta-native-packager");
  return { directory, userDirectory, base, env, run, install, service };
}

for (const platform of ["linux", "macos"]) {
  test(`native packager ${platform} scripts isolate two identities and preserve the other on uninstall`, (context) => {
    const { base, userDirectory, env, run, install } = lifecycleFixture(context);
    const first = "pkr_0123456789abcdef";
    const second = "pkr_fedcba9876543210";
    run(install(first, platform));
    run(install(second, platform));
    const root = path.join(base, first);
    const secondRoot = path.join(base, second);
    for (const id of [first, second]) {
      const identity = path.join(base, id, `identity-${id}.pem`);
      assert.equal(fs.readFileSync(identity, "utf8"), id);
      assert.equal(fs.statSync(identity).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(base, id)).mode & 0o777, 0o700);
    }
    assert.throws(() => run(install(first, platform)), /Installation existiert bereits/);
    if (platform === "linux") {
      const unit = fs.readFileSync(path.join(userDirectory, `.config/systemd/user/ananta-native-packager-${first}.service`), "utf8");
      assert.ok(unit.includes(`ReadWritePaths="%h/.local/share/ananta-native-packager/${first}"`));
      run(`exec "${root}/run-${first}"`);
    } else {
      const plist = fs.readFileSync(path.join(userDirectory, `Library/LaunchAgents/de.ananta.native-packager.${first}.plist`), "utf8");
      const shellCommand = /<string>-c<\/string><string>([^<]+)<\/string>/.exec(plist)?.[1];
      assert.ok(shellCommand, "launchd must use a shell to expand HOME, including spaces");
      run(shellCommand);
    }
    assert.equal(fs.readFileSync(env.INSTALLER_TEST_RUNS, "utf8"), first);
    const uninstall = fs.readFileSync(path.join(root, `uninstall-${first}`), "utf8");
    assert.throws(() => run(uninstall, { INSTALLER_TEST_STOP_FAIL: "1" }));
    assert.equal(fs.readFileSync(path.join(root, `identity-${first}.pem`), "utf8"), first);
    run(uninstall);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(path.join(secondRoot, "native-broadcast-packager")), true);
    assert.equal(fs.readFileSync(path.join(secondRoot, `identity-${second}.pem`), "utf8"), second);
    const secondService = platform === "linux"
      ? `.config/systemd/user/ananta-native-packager-${second}.service`
      : `Library/LaunchAgents/de.ananta.native-packager.${second}.plist`;
    assert.equal(fs.existsSync(path.join(userDirectory, secondService)), true);
    assert.equal(fs.existsSync(base), true);
  });
}

test("native packager installer rejects bad hashes and symlinks without touching another installation", (context) => {
  const { base, directory, env, run, install } = lifecycleFixture(context);
  const first = "pkr_0123456789abcdef";
  const second = "pkr_fedcba9876543210";
  run(install(first));
  const invalid = path.join(directory, "invalid-artifact");
  fs.writeFileSync(invalid, "invalid");
  assert.throws(() => run(install(second), { INSTALLER_TEST_ARTIFACT: invalid }), /SHA-256-Prüfung fehlgeschlagen/);
  assert.equal(fs.existsSync(path.join(base, second, "native-broadcast-packager")), false);
  assert.equal(fs.existsSync(path.join(base, second, "native-broadcast-packager.download")), false);
  assert.equal(fs.readFileSync(path.join(base, first, `identity-${first}.pem`), "utf8"), first);
  const third = "pkr_aaaaaaaaaaaaaaaa";
  fs.symlinkSync(path.join(base, first), path.join(base, third));
  assert.throws(() => run(install(third)), /Installation existiert bereits/);
  const movedBase = `${base}-real`;
  fs.renameSync(base, movedBase);
  fs.symlinkSync(movedBase, base);
  assert.throws(() => run(install("pkr_bbbbbbbbbbbbbbbb")), /kein Symlink/);
  const uninstall = fs.readFileSync(path.join(base, first, `uninstall-${first}`), "utf8");
  assert.throws(() => run(uninstall), /kein Symlink/);
  assert.equal(fs.readFileSync(path.join(movedBase, first, `identity-${first}.pem`), "utf8"), first);
  assert.equal(fs.existsSync(env.INSTALLER_TEST_RUNS), false);
});

test("native packager installer validates path-bound IDs against the contract before generating scripts", (context) => {
  const { directory, service } = fixture();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const packagerId of ["../outside", "pkr_abcdefghijklmnop/../else", "pkr_short", "pkr_abcdefghijklmnop\n", {}, undefined]) {
    assert.throws(() => service.installer({ enrollment: { ...enrollment("linux"), packagerId },
      targetId: "linux-amd64", publicOrigin: "https://webrtc.example" }), /invalid_native_packager_id/);
  }
});

test("native packager Windows installer and launcher parse in the real Windows PowerShell engine", {
  skip: process.env.RUN_WINDOWS_INSTALLER_PARSE !== "1" && "set RUN_WINDOWS_INSTALLER_PARSE=1 on Windows/WSL with powershell.exe",
}, (context) => {
  const { directory, service } = fixture();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { content } = service.installer({ enrollment: enrollment("windows"), targetId: "windows-amd64", publicOrigin: "https://webrtc.example" });
  const launcher = /\$launcherContent = @'\r?\n([\s\S]*?)\r?\n'@/.exec(content)?.[1];
  const uninstaller = /\$uninstallerContent = @'\r?\n([\s\S]*?)\r?\n'@/.exec(content)?.[1];
  const updater = /\$updaterContent = @'\r?\n([\s\S]*?)\r?\n'@/.exec(content)?.[1];
  assert.ok(launcher);
  assert.ok(uninstaller);
  assert.ok(updater);
  const parser = "$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors); if ($errors.Count -gt 0) { throw 'Installer syntax invalid' }; Write-Output 'PASS Windows PowerShell parser'";
  for (const script of [content, launcher, uninstaller, updater]) {
    const result = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", parser], {
      input: script, encoding: "utf8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"],
    });
    assert.match(result, /PASS Windows PowerShell parser/);
  }
});
