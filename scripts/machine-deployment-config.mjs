import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { machineDeploymentConfig } from "../src/machine-deployment-config.js";
import { readMachineTrustFile } from "../src/machine-trust-file.js";

try {
  if (process.argv.length !== 2) throw new Error();
  const selector = fileURLToPath(new URL("../infra/deployment/compose.machine-selection.yaml", import.meta.url));
  const rendered = execFileSync("docker", ["compose", "--project-directory", process.cwd(), "-f", selector,
    "config", "--format", "json"], { encoding: "utf8", timeout: 5000, maxBuffer: 524288, stdio: ["ignore", "pipe", "pipe"] });
  const value = machineDeploymentConfig(JSON.parse(rendered)["x-ananta-machine-deployment"], readMachineTrustFile);
  process.stdout.write(`${value.mode} ${value.admission}\n`);
} catch {
  // Compose errors and input may contain private material. Never forward either.
  process.stderr.write('{"status":"blocked","code":"machine_deployment_config_invalid"}\n');
  process.exitCode = 2;
}
