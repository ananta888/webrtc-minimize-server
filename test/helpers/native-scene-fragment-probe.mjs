import { execFile } from "node:child_process";

/** Synthetic-fixture colors only. Never return source pixels or stderr. */
export function classifyScenePixels(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 6) return null;
  return [0, 3].map(i => {
    const [r, g, b] = bytes.subarray(i, i + 3);
    return r > 150 && g < 90 && b < 90 ? "red" : b > 150 && r < 90 && g < 90 ? "blue"
      : r < 90 && g < 90 && b < 90 ? "slate" : "other";
  });
}

export async function probeSceneFragment(fragment) {
  if (!Buffer.isBuffer(fragment) || fragment.length < 1 || fragment.length > 4 * 1024 * 1024 + 65536) return null;
  return new Promise(resolve => {
    const child = execFile("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "pipe", "-f", "mp4", "-i", "pipe:0",
      "-an", "-frames:v", "1", "-vf", "format=rgb24,scale=2:1:flags=neighbor", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
    { timeout: 5000, maxBuffer: 4096, encoding: "buffer" }, (error, bytes) => resolve(error ? null : classifyScenePixels(bytes)));
    child.stdin.on("error", () => {}); child.stdin.end(fragment);
  });
}
