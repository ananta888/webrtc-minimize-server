import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.RUN_WINDOWS_NATIVE_PACKAGER !== "1") {
  console.log("SKIP Windows native-packager config/output gate: set RUN_WINDOWS_NATIVE_PACKAGER=1 on WSL with Docker and powershell.exe");
  process.exit(0);
}

// This gate executes only synthetic config/output/local media tests, never enrollment,
// capture, autostart installation, or production agent processes.
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "native-packager-windows-gate-"));
const binary = path.join(temporary, "native-packager-tests.exe");
const container = `native-packager-windows-gate-${path.basename(temporary).split("-").at(-1).toLowerCase()}`;
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
const liveMedia = process.env.RUN_WINDOWS_NATIVE_MEDIA === "1";

try {
  execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { stdio: "pipe", timeout: 15_000 });
  console.log("Building Windows amd64 tests with the pinned Go 1.24 toolchain …");
  execFileSync("docker", ["run", "--rm", "--name", container, "-e", "GOOS=windows", "-e", "GOARCH=amd64", "-e", "CGO_ENABLED=0",
    "-v", `${root}:/workspace:ro`, "-v", `${temporary}:/gate`, "-w", "/workspace/native-broadcast-packager",
    "golang:1.24-alpine", "go", "test", "-c", "-o", "/gate/native-packager-tests.exe"], { stdio: "pipe", timeout: 180_000 });
  const windowsPath = execFileSync("wslpath", ["-w", binary], { encoding: "utf8", timeout: 10_000 }).trim();
  const windowsDirectory = execFileSync("wslpath", ["-w", temporary], { encoding: "utf8", timeout: 10_000 }).trim();
  assert.ok(windowsPath && !/[\r\n\0]/.test(windowsPath));
  const selection = `^(TestCLI|TestConfig|TestTranscodeOutput|TestOutput|TestWindowsMediaPipe|TestWindowsJobKillsOnlyAgentDescendantsOnAbruptExit${liveMedia ? "|TestLiveVP8ToH264AACPipeline|TestLiveVP8OpusToH264AACPipeline" : ""})`;
  const result = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `${liveMedia ? "$env:RUN_LIVE_NATIVE_TRANSCODE='1'; " : ""}Set-Location -LiteralPath ${psQuote(windowsDirectory)}; & ${psQuote(windowsPath)} '-test.run=${selection}' '-test.v'; exit $LASTEXITCODE`],
  { encoding: "utf8", stdio: "pipe", timeout: liveMedia ? 120_000 : 60_000 });
  process.stdout.write(result);
  assert.match(result, /--- PASS: TestConfigOutputDefaultsArePortableAndIsolatedPerIdentity/);
  assert.match(result, /--- PASS: TestOutputScopeRejectsOSRootsAndMalformedPaths/);
  assert.match(result, /--- PASS: TestOutputCleanupRejectsWindowsRootJunction/);
  assert.match(result, /--- PASS: TestWindowsMediaPipeRejectsWrongPIDBeforeWritingHeaders/);
  assert.match(result, /--- PASS: TestWindowsJobKillsOnlyAgentDescendantsOnAbruptExit/);
  assert.match(result, /--- PASS: TestCLIPreflightPreservesIdentityAndMediaWithoutConnecting/);
  assert.match(result, /--- PASS: TestCLIPreflightNeverCreatesMissingIdentity/);
  if (liveMedia) {
    assert.match(result, /--- PASS: TestLiveVP8ToH264AACPipeline/);
    assert.match(result, /--- PASS: TestLiveVP8OpusToH264AACPipeline/);
  }
  assert.match(result, /(?:^|\r?\n)PASS\r?\n/);
  console.log(`PASS real Windows config/output/local-pipe tests; live media=${liveMedia}. Installation, autostart and signing remain separate gates.`);
} catch (error) {
  process.stderr.write(error.stdout?.toString() || "");
  process.stderr.write(error.stderr?.toString() || "");
  throw error;
} finally {
  // Exact per-run container and mkdtemp path only; no user-agent state exists here.
  try { execFileSync("docker", ["rm", "-f", container], { stdio: "pipe", timeout: 10_000 }); } catch { /* --rm already removed it */ }
  fs.rmSync(temporary, { recursive: true, force: true });
}
