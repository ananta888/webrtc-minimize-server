import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

if (process.env.RUN_LIVE_MEDIAMTX_LLHLS !== "1") {
  console.log("SKIP live MediaMTX LL-HLS gate: set RUN_LIVE_MEDIAMTX_LLHLS=1 with Docker and FFmpeg 6+");
  process.exit(0);
}

const project = `webrtc-llhls-${process.pid}`;
const resource = "res_aaaaaaaaaaaaaaaa";
const compose = [
  "compose", "--project-directory", ".", "-p", project,
  "-f", "infra/mediamtx/compose.yaml", "-f", "infra/mediamtx/compose.live-test.yaml",
  "--profile", "broadcast-gateway",
];
const environment = {
  ...process.env,
  MEDIAMTX_HLS_PORT: process.env.MEDIAMTX_HLS_PORT || "28888",
  MEDIAMTX_WHIP_PORT: process.env.MEDIAMTX_WHIP_PORT || "28889",
  MEDIAMTX_ICE_PORT: process.env.MEDIAMTX_ICE_PORT || "28189",
  MEDIAMTX_TEST_RTSP_PORT: process.env.MEDIAMTX_TEST_RTSP_PORT || "28554",
};
const hlsUrl = `http://127.0.0.1:${environment.MEDIAMTX_HLS_PORT}/${resource}/index.m3u8`;
const rtspUrl = `rtsp://127.0.0.1:${environment.MEDIAMTX_TEST_RTSP_PORT}/${resource}`;

function docker(args, ignoreFailure = false) {
  const result = spawnSync("docker", args, { cwd: process.cwd(), env: environment, encoding: "utf8" });
  if (!ignoreFailure && result.status !== 0) throw new Error(`docker_failed:${result.stderr.slice(0, 1_000)}`);
  return result.stdout.trim();
}

async function waitForMediaPlaylist({ timeoutMs = 25_000, rejectedMap = "" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const masterResponse = await fetch(hlsUrl, { signal: AbortSignal.timeout(2_000) });
      if (masterResponse.ok) {
        const master = await masterResponse.text();
        const child = master.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
        if (child) {
          const response = await fetch(new URL(child, hlsUrl), { signal: AbortSignal.timeout(2_000) });
          if (response.ok) {
            const media = await response.text();
            const map = media.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1] ?? "";
            if (media.includes("#EXT-X-PART") && map && map !== rejectedMap) {
              return { master, media, mediaUrl: new URL(child, hlsUrl), map };
            }
          }
        }
      }
    } catch { /* bounded startup retry */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("ll_hls_playlist_timeout");
}

function startPublisher() {
  const process = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-re",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000",
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-f", "rtsp", "-rtsp_transport", "tcp",
    rtspUrl,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const state = { process, stderr: "", closed: false, code: null };
  process.stderr.on("data", (chunk) => { state.stderr = `${state.stderr}${chunk}`.slice(-8_000); });
  process.once("close", (code) => {
    state.closed = true;
    state.code = code;
  });
  return state;
}

async function stopPublisher(state, signal = "SIGTERM") {
  if (!state || state.closed) return;
  const closed = new Promise((resolve) => state.process.once("close", resolve));
  state.process.kill(signal);
  const code = await closed;
  assert.ok(signal === "SIGKILL" || code === 0 || code === 255, state.stderr);
}

function assertPublisherRunning(state) {
  if (state.closed) throw new Error(`publisher_exited_${state.code}:${state.stderr}`);
}

async function fetchMediaObject(mediaUrl, relativeUri) {
  const response = await fetch(new URL(relativeUri, mediaUrl), { signal: AbortSignal.timeout(3_000) });
  assert.equal(response.status, 200);
  const body = await response.arrayBuffer();
  assert.ok(body.byteLength > 0);
}

async function waitForCleanup(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(hlsUrl, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 404) return;
    } catch { /* bounded cleanup retry */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("ll_hls_cleanup_timeout");
}

let publisher;
try {
  const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  assert.equal(ffmpeg.status, 0, "FFmpeg 6+ is required for the opt-in LL-HLS gate");
  docker([...compose, "up", "-d"]);
  publisher = startPublisher();
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assertPublisherRunning(publisher);
  const first = await waitForMediaPlaylist();
  const { master, media } = first;
  assert.match(master, /#EXT-X-STREAM-INF/);
  const version = Number(media.match(/#EXT-X-VERSION:(\d+)/)?.[1]);
  assert.ok(version >= 9, `expected LL-HLS protocol version >= 9, got ${version}`);
  assert.match(media, /#EXT-X-SERVER-CONTROL:.*CAN-BLOCK-RELOAD=YES/);
  const partTarget = Number(media.match(/#EXT-X-PART-INF:PART-TARGET=([\d.]+)/)?.[1]);
  assert.ok(partTarget >= 0.19 && partTarget <= 0.21, `unexpected part target ${partTarget}`);
  assert.match(media, /#EXT-X-MAP:/);
  assert.equal(Number(media.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1]), 2);
  assert.ok((media.match(/#EXT-X-PART:/g) || []).length <= 64);
  assert.doesNotMatch(`${master}\n${media}`, /(?:access_token|authorization|bearer)=/i);
  const mapUri = media.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1];
  const independentPart = media.match(/#EXT-X-PART:[^\n]*URI="([^"]+)"[^\n]*INDEPENDENT=YES/)?.[1];
  assert.ok(mapUri && independentPart);
  await Promise.all([
    fetchMediaObject(first.mediaUrl, mapUri),
    fetchMediaObject(first.mediaUrl, independentPart),
  ]);

  await stopPublisher(publisher);
  publisher = null;
  await waitForCleanup();

  publisher = startPublisher();
  assertPublisherRunning(publisher);
  const restarted = await waitForMediaPlaylist({ rejectedMap: first.map });
  assert.notEqual(restarted.map, first.map);
  await stopPublisher(publisher);
  publisher = null;
  await waitForCleanup();
  console.log("PASS MediaMTX LL-HLS: late H.264/AAC viewer, blocking reload, 200ms parts, bounded window, publisher restart and stale-muxer cleanup");
} finally {
  if (publisher && !publisher.closed) await stopPublisher(publisher, "SIGKILL");
  docker([...compose, "down", "--remove-orphans"], true);
}
