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
    else if (/user specified IP address.*user configured subnets/i.test(stderr)) reason = "network_subnet";
    else if (/Address already in use|address already allocated|IP address.*not.*subnet/i.test(stderr)) reason = "network_address";
    else if (/all predefined address pools have been fully subnetted/i.test(stderr)) reason = "network_pool_exhausted";
    else if (/network.*(?:has active endpoints|has active containers)/i.test(stderr)) reason = "network_busy";
    else if (/CPU.*(range|available)|NanoCPUs|CFS scheduler/i.test(stderr)) reason = "cpu_limit";
    else if (/permission denied|operation not permitted/i.test(stderr)) reason = "permission";
    else if (/Conflict.*container name|container name.*already in use/i.test(stderr)) reason = "container_conflict";
    else if (error?.code === "ETIMEDOUT") reason = "deadline";
    throw new Error(`test_docker_command_failed:${operation}:${status}:${reason}`);
  }
}

// A bridge may forward only this closed projection, never arbitrary Error text.
// Keep both private bridges on the same status and reason contract.
export function machineDockerFailure(error) {
  if (typeof error?.message !== "string") return null;
  const match = /^test_docker_command_failed:(create|start|inspect|image|network|rm|logs|unknown):(0|[1-9]\d{0,2}|unknown):(image_unavailable|image_platform|network_subnet|network_address|network_pool_exhausted|network_busy|cpu_limit|permission|container_conflict|deadline|unknown)$/.exec(error.message);
  if (!match || match[0] !== error.message || (match[2] !== "unknown" && Number(match[2]) > 255)) return null;
  return match[0];
}
