import { execFileSync } from "node:child_process";

// Test-only, closed diagnostics. Docker errors can contain the entire command,
// including a temporary TURN secret: never retain the original error/cause.
export function machineDockerCommand(args, execute = execFileSync) {
  try {
    return execute("docker", args, { encoding: "utf8", timeout: 30000,
      maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const operation = ["create", "start", "inspect", "image", "network", "rm", "logs"].includes(args[0])
      ? args[0] : "unknown";
    const status = Number.isInteger(error?.status) && error.status >= 0 && error.status <= 255 ? error.status : "unknown";
    const stderr = typeof error?.stderr === "string" ? error.stderr.slice(0, 16384) : "";
    let reason = "unknown";
    if (/No such image|Unable to find image|pull access denied/i.test(stderr)) reason = "image_unavailable";
    else if (/no matching manifest|does not match the specified platform/i.test(stderr)) reason = "image_platform";
    else if (/Address already in use|address already allocated|IP address.*not.*subnet/i.test(stderr)) reason = "network_address";
    else if (/CPU.*(range|available)|NanoCPUs|CFS scheduler/i.test(stderr)) reason = "cpu_limit";
    else if (/permission denied|operation not permitted/i.test(stderr)) reason = "permission";
    else if (/Conflict.*container name|container name.*already in use/i.test(stderr)) reason = "container_conflict";
    else if (error?.code === "ETIMEDOUT") reason = "deadline";
    throw new Error(`test_docker_command_failed:${operation}:${status}:${reason}`);
  }
}
