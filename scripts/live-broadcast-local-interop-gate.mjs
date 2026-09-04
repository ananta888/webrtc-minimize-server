import { spawnSync } from "node:child_process";
import os from "node:os";

function run(command, args, env = process.env, quiet = false) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    stdio: quiet ? "ignore" : "inherit",
  });
  if (result.status !== 0) throw new Error(`local_interop_command_failed:${command}:${result.status}`);
}

if (process.env.RUN_LIVE_BROADCAST_LOCAL_INTEROP !== "1") {
  console.log("SKIP local broadcast interoperability gate: set RUN_LIVE_BROADCAST_LOCAL_INTEROP=1 with Docker, FFmpeg, Chromium and Firefox");
  process.exit(0);
}

run(process.execPath, ["scripts/live-mediamtx-adapter-gate.mjs"], {
  ...process.env, RUN_LIVE_MEDIAMTX_ADAPTER: "1",
});
run(process.execPath, ["scripts/live-native-packager-gate.mjs"], {
  ...process.env, RUN_LIVE_NATIVE_PACKAGER: "1",
});
run(process.execPath, ["scripts/live-mediamtx-llhls-gate.mjs"], {
  ...process.env, RUN_LIVE_MEDIAMTX_LLHLS: "1",
});

const address = Object.values(os.networkInterfaces()).flat()
  .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;
const project = `webrtc-whip-interop-${process.pid}`;
const environment = {
  ...process.env,
  MEDIAMTX_ICE_PORT: "8189",
  MEDIAMTX_ADDITIONAL_HOSTS: ["127.0.0.1", address].filter(Boolean).join(","),
};
const compose = [
  "compose", "--project-directory", ".", "-p", project,
  "-f", "infra/mediamtx/compose.yaml", "-f", "infra/mediamtx/compose.live-test.yaml",
  "--profile", "broadcast-gateway",
];
try {
  run("docker", [...compose, "up", "-d"], environment);
  run(process.execPath, ["scripts/live-whip-mediamtx-gate.mjs"], {
    ...environment, RUN_LIVE_WHIP_MEDIAMTX: "1",
  });
} finally {
  run("docker", [...compose, "down", "--remove-orphans"], environment, true);
}

console.log("PASS local broadcast interoperability gate: MediaMTX, native ABR, LL-HLS and Chromium/Firefox WHIP");
