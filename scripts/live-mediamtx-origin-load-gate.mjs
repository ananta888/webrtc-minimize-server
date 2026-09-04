import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

if (process.env.RUN_LIVE_MEDIAMTX_ORIGIN_LOAD !== "1") {
  console.log("SKIP MediaMTX origin load gate: set RUN_LIVE_MEDIAMTX_ORIGIN_LOAD=1 with Docker and FFmpeg 6+");
  process.exit(0);
}

const project = `webrtc-origin-load-${process.pid}`;
const resource = "res_loadtestaaaaaaaa";
const viewerCount = Number(process.env.MEDIAMTX_LOAD_VIEWERS || 20);
const durationMs = Number(process.env.MEDIAMTX_LOAD_DURATION_MS || 15_000);
assert.ok(Number.isSafeInteger(viewerCount) && viewerCount >= 1 && viewerCount <= 100);
assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 5_000 && durationMs <= 300_000);
const compose = [
  "compose", "--project-directory", ".", "-p", project,
  "-f", "infra/mediamtx/compose.yaml", "-f", "infra/mediamtx/compose.live-test.yaml",
  "--profile", "broadcast-gateway",
];
const environment = {
  ...process.env,
  MEDIAMTX_HLS_PORT: process.env.MEDIAMTX_HLS_PORT || "38888",
  MEDIAMTX_WHIP_PORT: process.env.MEDIAMTX_WHIP_PORT || "38889",
  MEDIAMTX_ICE_PORT: process.env.MEDIAMTX_ICE_PORT || "38189",
  MEDIAMTX_TEST_RTSP_PORT: process.env.MEDIAMTX_TEST_RTSP_PORT || "38554",
};
const masterUrl = `http://127.0.0.1:${environment.MEDIAMTX_HLS_PORT}/${resource}/index.m3u8`;
const rtspUrl = `rtsp://127.0.0.1:${environment.MEDIAMTX_TEST_RTSP_PORT}/${resource}`;

function docker(args, ignoreFailure = false) {
  const result = spawnSync("docker", args, { cwd: process.cwd(), env: environment, encoding: "utf8" });
  if (!ignoreFailure && result.status !== 0) throw new Error(`docker_failed:${result.stderr.slice(0, 1_000)}`);
  return result.stdout.trim();
}

async function fetchBody(url, timeoutMs = 3_000) {
  const started = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const body = await response.arrayBuffer();
  return { text: new TextDecoder().decode(body), bytes: body.byteLength, latencyMs: performance.now() - started };
}

async function waitForMaster(publisher, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (publisher.exitCode !== null) throw new Error(`publisher_exited_${publisher.exitCode}`);
    try {
      const master = await fetchBody(masterUrl);
      const child = master.text.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
      if (child) return child;
    } catch { /* bounded startup retry */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("origin_load_startup_timeout");
}

function latestPart(playlist) {
  const matches = [...playlist.matchAll(/#EXT-X-PART:[^\n]*URI="([^"]+)"/g)];
  return matches.at(-1)?.[1] || "";
}

function blockingUrl(mediaUrl, playlist) {
  const sequence = Number(playlist.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] || 0);
  const segmentCount = (playlist.match(/#EXTINF:/g) || []).length;
  const part = latestPart(playlist).match(/part(\d+)\.mp4/)?.[1];
  const url = new URL(mediaUrl);
  url.searchParams.set("_HLS_msn", String(sequence + segmentCount));
  url.searchParams.set("_HLS_part", String(part ? Number(part) + 1 : 0));
  return url;
}

let publisher;
try {
  docker([...compose, "up", "-d"]);
  publisher = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-re",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000",
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-f", "rtsp", "-rtsp_transport", "tcp", rtspUrl,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let publisherError = "";
  publisher.stderr.on("data", (chunk) => { publisherError = `${publisherError}${chunk}`.slice(-8_000); });
  await waitForMaster(publisher);
  const deadline = Date.now() + durationMs;
  const measurements = { requests: 0, bytes: 0, errors: 0, errorSamples: [], latencies: [], viewers: new Set(), blockingReloads: 0 };
  const runViewer = async (viewerId) => {
    try {
      const master = await fetchBody(masterUrl);
      const child = master.text.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
      assert.ok(child);
      const mediaUrl = new URL(child, masterUrl);
      let playlist = (await fetchBody(mediaUrl)).text;
      const blockingController = new AbortController();
      const blockingRequest = fetch(blockingUrl(mediaUrl, playlist), { signal: blockingController.signal })
        .then(() => false)
        .catch((error) => {
          if (error?.name === "AbortError") return true;
          throw error;
        });
      setTimeout(() => blockingController.abort(), 750);
      if (await blockingRequest) measurements.blockingReloads += 1;
      while (Date.now() < deadline) {
        const blocked = await fetchBody(mediaUrl);
        measurements.requests += 1;
        measurements.bytes += blocked.bytes;
        measurements.latencies.push(blocked.latencyMs);
        playlist = blocked.text;
        const part = latestPart(playlist);
        if (part) {
          const media = await fetchBody(new URL(part, mediaUrl));
          measurements.requests += 1;
          measurements.bytes += media.bytes;
          measurements.latencies.push(media.latencyMs);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      measurements.viewers.add(viewerId);
    } catch (error) {
      measurements.errors += 1;
      if (measurements.errorSamples.length < 3) measurements.errorSamples.push(error instanceof Error ? error.message : String(error));
    }
  };
  await Promise.all(Array.from({ length: viewerCount }, (_, index) => runViewer(index)));
  const elapsedSeconds = durationMs / 1_000;
  const sorted = measurements.latencies.toSorted((left, right) => left - right);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0;
  const container = docker([...compose, "ps", "-q", "broadcast-gateway"]);
  const stats = docker(["stats", "--no-stream", "--format", "{{json .}}", container]);
  const result = {
    gate: "mediamtx-origin-llhls-v1", viewerCount, durationMs,
    requests: measurements.requests,
    requestsPerSecond: Number((measurements.requests / elapsedSeconds).toFixed(2)),
    bytes: measurements.bytes,
    egressMegabitsPerSecond: Number((measurements.bytes * 8 / elapsedSeconds / 1_000_000).toFixed(2)),
    p95RequestLatencyMs: Number(p95.toFixed(2)),
    errors: measurements.errors,
    errorSamples: measurements.errorSamples,
    completedViewers: measurements.viewers.size,
    observedConcurrentBlockingReloads: measurements.blockingReloads,
    containerStats: JSON.parse(stats),
  };
  console.log(JSON.stringify(result));
  assert.equal(measurements.errors, 0);
  assert.equal(measurements.viewers.size, viewerCount);
  assert.equal(measurements.blockingReloads, viewerCount);
  assert.ok(measurements.requests / elapsedSeconds >= viewerCount * 4);
  assert.ok(p95 < 2_500);
  publisher.kill("SIGTERM");
  const code = await new Promise((resolve) => publisher.once("close", resolve));
  assert.ok(code === 0 || code === 255, publisherError);
  publisher = null;
} finally {
  if (publisher?.exitCode === null) publisher.kill("SIGKILL");
  docker([...compose, "down", "--remove-orphans"], true);
}
