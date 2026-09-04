import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const modules = ["broadcast-hls-origin", "native-broadcast-packager"];

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw result.error || new Error(`${command} failed with status ${result.status}`);
  }
  process.stdout.write(result.stdout || "");
}

const localGo = spawnSync("go", ["version"], { encoding: "utf8", stdio: "pipe" });
if (!localGo.error && localGo.status === 0) {
  for (const module of modules) {
    run("go", ["test", "./..."], new URL(`../${module}/`, import.meta.url));
    run("go", ["vet", "./..."], new URL(`../${module}/`, import.meta.url));
  }
} else {
  run("docker", [
    "run", "--rm", "-v", `${root}:/workspace`, "-w", "/workspace",
    "golang:1.24-alpine", "sh", "-c",
    "set -eu; for module in broadcast-hls-origin native-broadcast-packager; do cd /workspace/$module; go test ./...; go vet ./...; done",
  ]);
}

process.stdout.write("Go origin and native-packager unit/vet gates passed.\n");
