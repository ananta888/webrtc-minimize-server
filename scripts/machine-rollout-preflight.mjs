import { open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { machineRolloutPreflight } from "../src/machine-rollout-preflight.js";

// Environment/config is supplied by the operator. No dotenv rewriting, HTTP,
// token/grant creation, trust registration or access to the Ananta repository.
try {
  if (process.argv.length !== 3) throw new Error("invalid_arguments");
  const file = await open(process.argv[2], "r");
  let plan;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 8192) throw new Error("invalid_plan_size");
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw new Error("invalid_plan_size");
    plan = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const git = args => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const result = machineRolloutPreflight({ plan, config: loadConfig(), revision: git(["rev-parse", "HEAD"]),
    clean: git(["status", "--porcelain", "--untracked-files=normal"]) === "" });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.localReady ? 0 : 2;
} catch {
  // Input may contain secrets or hostile keys. Never print it or raw exceptions.
  process.stdout.write(JSON.stringify({ schema: "ananta.meet-rollout-preflight.v1", status: "blocked",
    localReady: false, productionReady: false, code: "machine_preflight_input_or_config_invalid" }) + "\n");
  process.exitCode = 2;
}
