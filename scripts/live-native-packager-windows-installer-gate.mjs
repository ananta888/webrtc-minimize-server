import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativePackagerInstallerService } from "../src/native-packager-installers.js";

if (process.env.RUN_WINDOWS_PACKAGER_INSTALLER !== "1") {
  console.log("SKIP real Windows installer lifecycle: set RUN_WINDOWS_PACKAGER_INSTALLER=1 on WSL with powershell.exe and FFmpeg");
  process.exit(0);
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-packager-installer-gate-"));
const windowsPath = (value) => execFileSync("wslpath", ["-w", value], { encoding: "utf8" }).trim();
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const run = (command, timeout = 60_000) => execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { encoding: "utf8", stdio: "pipe", timeout });
try {
  // No real registration, keys or media: only fixture identity and PID files.
  const source = `using System; using System.IO; using System.Diagnostics; using System.Threading;
public class SyntheticPackager {
  public static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "enroll") {
      File.WriteAllText(Environment.GetEnvironmentVariable("NATIVE_PACKAGER_IDENTITY_FILE"), Environment.GetEnvironmentVariable("NATIVE_PACKAGER_ID")); return 0;
    }
    string output = Environment.GetEnvironmentVariable("NATIVE_PACKAGER_OUTPUT_ROOT");
    Directory.CreateDirectory(output);
    File.WriteAllText(Path.Combine(output,"process.pid"), Process.GetCurrentProcess().Id.ToString());
    Thread.Sleep(60000); return 0;
  }
}`;
  const sourcePath = path.join(directory, "fixture.cs");
  fs.writeFileSync(sourcePath, source, { mode: 0o600 });
  const artifactPath = path.join(directory, "native-broadcast-packager-windows-amd64.exe");
  run(`Add-Type -TypeDefinition ([IO.File]::ReadAllText(${quote(windowsPath(sourcePath))})) -OutputAssembly ${quote(windowsPath(artifactPath))} -OutputType ConsoleApplication`);
  const service = new NativePackagerInstallerService({ directory });
  const ids = ["pkr_0123456789abcdef", "pkr_fedcba9876543210"];
  for (const id of ids) {
    const { content } = service.installer({ enrollment: { packagerId: id, enrollmentToken: "A".repeat(43), platform: "windows" }, targetId: "windows-amd64", publicOrigin: "https://webrtc.example" });
    fs.writeFileSync(path.join(directory, `${id}.ps1`), `\uFEFF${content}`, { mode: 0o600 });
    if (id === ids[0]) fs.writeFileSync(path.join(directory, "duplicate.ps1"), `\uFEFF${content}`, { mode: 0o600 });
  }
  const badHash = service.installer({ enrollment: { packagerId: "pkr_aaaaaaaaaaaaaaaa", enrollmentToken: "A".repeat(43), platform: "windows" }, targetId: "windows-amd64", publicOrigin: "https://webrtc.example" });
  fs.writeFileSync(path.join(directory, "bad-hash.ps1"), `\uFEFF${badHash.content}`, { mode: 0o600 });
  const harness = fileURLToPath(new URL("./testing/native-packager-windows-installer.ps1", import.meta.url));
  const output = run(`& ${quote(windowsPath(harness))} -FixtureDirectory ${quote(windowsPath(directory))}`, 90_000);
  process.stdout.write(output);
  assert.match(output, /PASS two real Windows script installations/);
  assert.match(output, /PASS generated Windows autostart command/);
  assert.match(output, /PASS duplicate\/hash protection/);
} catch (error) {
  process.stderr.write(error.stdout?.toString() || "");
  process.stderr.write(error.stderr?.toString() || "");
  throw error;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
