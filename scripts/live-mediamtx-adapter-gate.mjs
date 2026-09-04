import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

if (process.env.RUN_LIVE_MEDIAMTX_ADAPTER !== "1") {
  console.log("SKIP live pinned MediaMTX adapter gate: set RUN_LIVE_MEDIAMTX_ADAPTER=1");
  process.exit(0);
}

const project = `webrtc-mediamtx-gate-${process.pid}`;
const compose = [
  "compose", "--project-directory", ".", "-p", project, "-f", "infra/mediamtx/compose.yaml",
  "--profile", "broadcast-gateway",
];
const environment = {
  ...process.env,
  MEDIAMTX_HLS_PORT: process.env.MEDIAMTX_HLS_PORT || "28888",
  MEDIAMTX_WHIP_PORT: process.env.MEDIAMTX_WHIP_PORT || "28889",
  MEDIAMTX_ICE_PORT: process.env.MEDIAMTX_ICE_PORT || "28189",
};

function docker(args, options = {}) {
  const result = spawnSync("docker", args, {
    cwd: process.cwd(), env: environment, encoding: "utf8", ...options,
  });
  if (result.status !== 0) {
    throw new Error(`docker_failed:${result.stderr.trim().slice(0, 1_000)}`);
  }
  return result.stdout.trim();
}

async function waitFor(url, expected) {
  let last = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1_000) });
      last = response.status;
      if (expected.includes(last)) return last;
    } catch { /* bounded startup retry */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`mediamtx_probe_failed:${last}`);
}

async function waitForHealthy(containerId) {
  let state = "unknown";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const inspect = JSON.parse(docker(["inspect", containerId]))[0];
    state = inspect.State.Health?.Status || inspect.State.Status;
    if (state === "healthy") return inspect;
    if (state === "unhealthy" || inspect.State.Running !== true) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`mediamtx_unhealthy:${state}`);
}

try {
  docker([...compose, "up", "-d"]);
  const containerId = docker([...compose, "ps", "-q", "broadcast-gateway"]);
  assert.match(containerId, /^[a-f0-9]{12,64}$/);
  await waitFor(`http://127.0.0.1:${environment.MEDIAMTX_WHIP_PORT}/`, [404]);
  assert.equal(await waitFor(
    `http://127.0.0.1:${environment.MEDIAMTX_HLS_PORT}/not-allowed/index.m3u8?cookieCheck=1`,
    [401],
  ), 401);
  assert.equal(await waitFor(
    `http://127.0.0.1:${environment.MEDIAMTX_HLS_PORT}/res_aaaaaaaaaaaaaaaa/index.m3u8?cookieCheck=1`,
    [404],
  ), 404);
  const inspect = await waitForHealthy(containerId);
  assert.deepEqual(Object.keys(inspect.NetworkSettings.Ports).filter((port) => (
    inspect.NetworkSettings.Ports[port] !== null
  )).sort(), ["8189/udp", "8888/tcp", "8889/tcp"]);
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspect.HostConfig.Privileged, false);
  assert.ok(inspect.HostConfig.CapDrop.includes("ALL"));
  console.log("PASS pinned MediaMTX 1.20.1 adapter: healthy, loopback-only media, internal API/metrics, unknown path denied");
} finally {
  try { docker([...compose, "down", "--remove-orphans"], { stdio: "ignore" }); } catch { /* primary failure wins */ }
}
