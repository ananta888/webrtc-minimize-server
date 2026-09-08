import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/** Real deterministic encoded media, synthetic test pixels and policy only. */
export function syntheticAvatarVideo() {
  const bytes = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
    "color=c=red:s=256x256:r=12:d=0.5[r];color=c=blue:s=256x256:r=12:d=0.5[b];[r][b]concat=n=2:v=1:a=0",
    "-an", "-sn", "-dn", "-map_metadata", "-1", "-frames:v", "12", "-c:v", "libx264", "-threads", "1",
    "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"],
  { timeout: 15000, maxBuffer: 1_500_000, stdio: ["ignore", "pipe", "pipe"] });
  return { mp4: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), frames: 12,
    repeatMode: "loop", originKind: "generated", classification: "test_only" };
}

export async function openTestVideoAvatar({ sourceId, video }) {
  window.__avatarTestPulse?.stop();
  const source = window.anantaMachine.avatar, pending = source.open(sourceId, "persona-video-v1", video);
  const generation = source.status().generation;
  const controller = { timer: null, stop() { clearInterval(this.timer); } };
  window.__avatarTestPulse = controller;
  controller.timer = setInterval(() => { try { source.pulse(generation); } catch { controller.stop(); } }, 1000);
  try { return await pending; } catch (error) { controller.stop(); throw error; }
}
