import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { machineRolloutPreflight } from "../src/machine-rollout-preflight.js";
import { readMachineTrustFile } from "../src/machine-trust-file.js";
import { parseMachineTrustJson } from "../src/machine-trust-json.js";

// Environment/config is supplied by the operator. No dotenv rewriting, HTTP,
// token/grant creation, trust registration or access to the Ananta repository.
try {
  if (process.argv.length !== 3) throw new Error("invalid_arguments");
  const plan = parseMachineTrustJson(readMachineTrustFile(process.argv[2], 8192), 8192);
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
