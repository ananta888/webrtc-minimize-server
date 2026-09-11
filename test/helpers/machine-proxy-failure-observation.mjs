import { execFileSync } from "node:child_process";
import { projectMachineProxyResources } from "./machine-proxy-resources.mjs";

/** Failure-only inspection of an owned fixture, never a general Docker/log API. */
export function observeMachineProxyFailure(name, execute = execFileSync) {
  if (typeof name !== "string" || /^meet-test-tls-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(name)?.[0] !== name) return null;
  const read = args => {
    try {
      const value = execute("docker", args, { encoding: "utf8", timeout: 1000, killSignal: "SIGKILL",
        maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] });
      return typeof value === "string" && Buffer.byteLength(value, "utf8") <= 4096 ? value : null;
    } catch { return null; /* Error objects may contain private command/environment data. */ }
  };
  const state = read(["inspect", "--format", "{{json .State}}", name]);
  const logs = read(["logs", "--tail", "16", name]);
  const resources = projectMachineProxyResources(read(["exec", name, "cat", "/proc/1/stat",
    "/sys/fs/cgroup/cpu.stat", "/sys/fs/cgroup/memory.events"]));
  let container = null;
  try {
    const value = JSON.parse(state);
    if (value && typeof value === "object" && !Array.isArray(value)
      && ["created", "running", "paused", "restarting", "removing", "exited", "dead"].includes(value.Status)
      && typeof value.Running === "boolean" && typeof value.OOMKilled === "boolean"
      && Number.isInteger(value.ExitCode) && value.ExitCode >= 0 && value.ExitCode <= 255) {
      container = Object.freeze({ status: value.Status, running: value.Running,
        oomKilled: value.OOMKilled, exitCode: value.ExitCode });
    }
  } catch { /* Unknown or oversized state is not a healthy container. */ }
  const announced = marker => logs === null ? null : logs.split("\n").some(line => line === marker);
  return Object.freeze({ container, processEntered: announced("test_tls_process_entered"),
    networkModuleLoaded: announced("test_tls_network_module_loaded"), listenerAnnounced: announced("test_tls_listener_ready"), resources });
}
