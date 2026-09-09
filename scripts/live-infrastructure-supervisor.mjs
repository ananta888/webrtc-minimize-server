import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./live-infrastructure-worker.mjs", import.meta.url));
const environmentKeys = ["PATH", "HOME", "LANG", "TZ", "PLAYWRIGHT_BROWSERS_PATH", "NODE_EXTRA_CA_CERTS",
  "LIVE_APP_ORIGIN", "LIVE_OIDC_ISSUER", "LIVE_OIDC_USERNAME", "LIVE_OIDC_PASSWORD",
  "LIVE_REQUIRE_EDGE_TURN", "LIVE_REQUIRE_INFRASTRUCTURE_TURN", "LIVE_EDGE_TURN_HOST"];
const fields = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === names.length && Object.keys(value).every(key => names.includes(key));

export function validLiveReport(value) {
  if (!fields(value, ["status", "relays"]) || !["passed", "failed"].includes(value.status)
    || !Array.isArray(value.relays) || value.relays.length > 2) return false;
  if (value.status === "failed") return value.relays.length === 0;
  return value.relays.length > 0 && new Set(value.relays.map(row => row?.tier)).size === value.relays.length
    && value.relays.every(row => fields(row, ["tier", "candidateCount", "relayCount", "selectedRelayPairs", "payloadBytesEachDirection"])
      && ["peer-edge", "infrastructure", "configured"].includes(row.tier)
      && Number.isInteger(row.candidateCount) && row.candidateCount > 0 && row.candidateCount <= 4096
      && Number.isInteger(row.relayCount) && row.relayCount >= 2 && row.relayCount <= row.candidateCount
      && row.selectedRelayPairs === 2 && row.payloadBytesEachDirection === 32);
}

function result(status, code, relays = []) {
  return { schema: "ananta.meet-live-infrastructure-result.v1", status, code, relays,
    productionReleaseEvidence: false, selectedPairAndPayloadVerified: status === "passed",
    payloadScope: "same-browser-synthetic-datachannel", externalReceiverVerified: false, applicationMediaVerified: false };
}

function validEndpoint(value, issuer = false) {
  try {
    if (typeof value !== "string" || value.length > 2048 || /[\s\\]/.test(value)) return false;
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      && value === (issuer ? url.origin + url.pathname.replace(/\/$/, "") : url.origin);
  } catch { return false; }
}

/** Fixed child entry point, no shell/command input, inherited approval or raw output. */
export async function superviseLiveInfrastructure({ environment = process.env, forkImpl = fork,
  kill = process.kill.bind(process), timeoutMs = 120000, platform = process.platform } = {}) {
  if (!["linux", "darwin"].includes(platform)) return result("failed", "live_process_groups_unavailable");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return result("failed", "live_supervisor_config_invalid");
  if (!["LIVE_OIDC_USERNAME", "LIVE_OIDC_PASSWORD"].every(key => typeof environment[key] === "string"
    && environment[key].length > 0 && environment[key].length <= 8192)) return result("failed", "live_credentials_missing");
  if (!validEndpoint(environment.LIVE_APP_ORIGIN || "http://localhost:8080")
    || !validEndpoint(environment.LIVE_OIDC_ISSUER || "http://localhost:8081/realms/webrtc", true)) {
    return result("failed", "live_endpoint_invalid");
  }
  if (["LIVE_REQUIRE_EDGE_TURN", "LIVE_REQUIRE_INFRASTRUCTURE_TURN"].some(key =>
    environment[key] !== undefined && !["0", "1"].includes(environment[key]))) {
    return result("failed", "live_supervisor_config_invalid");
  }
  const env = { RUN_LIVE_INFRASTRUCTURE: "1" };
  for (const key of environmentKeys) if (typeof environment[key] === "string") env[key] = environment[key];
  return new Promise(resolve => {
    let child, timer, report, settling = false;
    const signal = name => {
      if (!Number.isInteger(child?.pid) || child.pid <= 1) return false;
      try { kill(-child.pid, name); return true; }
      catch (error) { if (error.code === "ESRCH") return false; throw new Error("live_cleanup_failed"); }
    };
    const finish = async (status, code) => {
      if (settling) return;
      settling = true; clearTimeout(timer);
      const relays = status === "passed" ? report.relays.map(row => ({ ...row })) : [];
      process.off("SIGTERM", cancelled); process.off("SIGINT", cancelled);
      try {
        if (signal("SIGTERM")) {
          await new Promise(done => setTimeout(done, 250));
          signal("SIGKILL");
        }
      } catch { status = "failed"; code = "live_cleanup_failed"; }
      resolve(result(status, code, status === "passed" ? relays : []));
    };
    const cancelled = () => { void finish("failed", "live_cancelled"); };
    try {
      child = forkImpl(worker, [], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env,
        execArgv: ["--max-old-space-size=256"] });
      child.on("error", () => { void finish("failed", "live_child_failed"); });
      child.on("message", message => {
        if (settling) return;
        if (report || !validLiveReport(message)) { void finish("failed", "live_report_invalid"); return; }
        report = structuredClone(message);
      });
      child.on("exit", code => {
        const passed = code === 0 && report?.status === "passed";
        void finish(passed ? "passed" : "failed", passed ? "live_checks_passed" : "live_child_failed");
      });
      process.once("SIGTERM", cancelled); process.once("SIGINT", cancelled);
      timer = setTimeout(() => { void finish("failed", "live_deadline_exceeded"); }, timeoutMs);
    } catch { void finish("failed", "live_child_failed"); }
  });
}
