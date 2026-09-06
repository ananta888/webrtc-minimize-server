import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativePackagerInstallerService } from "../src/native-packager-installers.js";

if (process.env.RUN_WINDOWS_PACKAGER_UPDATER !== "1") {
  console.log("SKIP real Windows updater lifecycle: set RUN_WINDOWS_PACKAGER_UPDATER=1 on WSL with powershell.exe and FFmpeg");
  process.exit(0);
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-packager-updater-gate-"));
const windowsPath = value => execFileSync("wslpath", ["-w",value], {encoding:"utf8"}).trim();
const quote = value => `'${value.replaceAll("'","''")}'`;
const run = (command, timeout=30_000) => execFileSync("powershell.exe", ["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command",command], {encoding:"utf8",stdio:"pipe",timeout});
try {
  for (const version of ["old","new","badpreflight","badstart","delayed"]) {
    const source = `using System; using System.IO; using System.Diagnostics; using System.Threading;
public class SyntheticPackager {
  public static int Main(string[] args) {
    string version = "${version}";
    if (args.Length == 1 && args[0] == "enroll") { File.WriteAllText(Environment.GetEnvironmentVariable("NATIVE_PACKAGER_IDENTITY_FILE"),Environment.GetEnvironmentVariable("NATIVE_PACKAGER_ID")); return 0; }
    if (args.Length == 1 && args[0] == "preflight") { Console.WriteLine("synthetic-preflight-not-for-logs"); return version == "badpreflight" ? 42 : 0; }
    if (version == "badstart") return 42;
    string output = Environment.GetEnvironmentVariable("NATIVE_PACKAGER_OUTPUT_ROOT"); Directory.CreateDirectory(output);
    File.WriteAllText(Path.Combine(output,"process.pid"),Process.GetCurrentProcess().Id.ToString());
    File.WriteAllText(Path.Combine(output,"version.txt"),version);
    Thread.Sleep(version == "delayed" ? 3000 : 600000); return 0;
  }
}`;
    const sourceFile = path.join(directory,`${version}.cs`);
    fs.writeFileSync(sourceFile,source);
    run(`Add-Type -TypeDefinition ([IO.File]::ReadAllText(${quote(windowsPath(sourceFile))})) -OutputAssembly ${quote(windowsPath(path.join(directory,`${version}.exe`)))} -OutputType ConsoleApplication`);
  }
  fs.copyFileSync(path.join(directory,"old.exe"),path.join(directory,"native-broadcast-packager-windows-amd64.exe"));
  const service = new NativePackagerInstallerService({directory});
  for (const id of ["pkr_0123456789abcdef","pkr_fedcba9876543210"]) {
    const { content } = service.installer({enrollment:{packagerId:id,platform:"windows",enrollmentToken:"A".repeat(43)},targetId:"windows-amd64",publicOrigin:"https://webrtc.example"});
    fs.writeFileSync(path.join(directory,`${id}.ps1`),`\uFEFF${content}`);
  }
  const harness=fileURLToPath(new URL("./testing/native-packager-windows-updater.ps1",import.meta.url));
  const downloadOrigin = process.env.WINDOWS_PACKAGER_DOWNLOAD_ORIGIN || "";
  if (downloadOrigin) { const url = new URL(downloadOrigin); assert.equal(url.protocol,"https:"); assert.equal(url.origin,downloadOrigin); }
  const output=run(`& ${quote(windowsPath(harness))} -FixtureDirectory ${quote(windowsPath(directory))} -DownloadOrigin ${quote(downloadOrigin)}`,360_000);
  process.stdout.write(output);
  assert.match(output,/PASS Windows update, rollback and automatic failure recovery/);
  assert.match(output,/PASS interrupted Windows transaction recovery and default launcher fence/);
  assert.match(output,/PASS Windows bounded downloads, preflight, locks, backup rejection and two-agent isolation/);
  assert.doesNotMatch(output,/synthetic-preflight-not-for-logs/);
  if (downloadOrigin) assert.match(output,/PASS real Windows HTTPS artifact download without execution/);
} catch(error) {
  process.stderr.write(error.stdout?.toString()||""); process.stderr.write(error.stderr?.toString()||""); throw error;
} finally { fs.rmSync(directory,{recursive:true,force:true}); }
