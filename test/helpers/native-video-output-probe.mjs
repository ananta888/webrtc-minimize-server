import { execFile } from "node:child_process";

export function videoOutputProbeResult(text) {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text) > 4096) return null;
    const streams = JSON.parse(text).streams;
    if (!Array.isArray(streams) || streams.length !== 1) return null;
    const s = streams[0], frames = Number(s.nb_read_frames);
    const rate = typeof s.r_frame_rate === "string" && /^(\d+)\/1$/.exec(s.r_frame_rate);
    if (s.codec_name !== "h264" || !Number.isInteger(s.width) || s.width < 160 || s.width > 1280
      || !Number.isInteger(s.height) || s.height < 90 || s.height > 720
      || !rate || Number(rate[1]) < 1 || Number(rate[1]) > 60
      || !Number.isInteger(frames) || frames < 1 || frames > 180) return null;
    return { codec: "h264", width: s.width, height: s.height, framesPerSecond: Number(rate[1]), decodedFrames: frames };
  } catch { return null; }
}

/** Only the owned synthetic fixture's bounded fragment; never paths or raw logs. */
export async function probeNativeVideoOutput(fragment) {
  if (!Buffer.isBuffer(fragment) || fragment.length < 1 || fragment.length > 4 * 1024 * 1024 + 65536) return null;
  return new Promise(resolve => {
    const child = execFile("ffprobe", ["-v", "error", "-protocol_whitelist", "pipe", "-f", "mp4", "-i", "pipe:0",
      "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_read_frames", "-of", "json"],
    { timeout: 5000, maxBuffer: 4096, encoding: "utf8" }, (error, text) => resolve(error ? null : videoOutputProbeResult(text)));
    child.stdin.on("error", () => {}); child.stdin.end(fragment);
  });
}
