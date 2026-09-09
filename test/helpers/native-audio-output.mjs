import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export function nativeAudioFragmentNames(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 65536) throw new Error("test_audio_manifest_invalid");
  const init = text.match(/^#EXT-X-MAP:URI="(init(?:_[0-9]+)?\.mp4)"$/m)?.[1];
  const sequence = text.match(/^#EXT-X-MEDIA-SEQUENCE:([0-9]+)$/m)?.[1];
  const media = text.split(/\r?\n/).filter(line => line && !line.startsWith("#"));
  if (!init || sequence === undefined || !Number.isSafeInteger(Number(sequence)) || !media.length || media.length > 8
    || media.some(name => !/^segment_[0-9]{9}\.m4s$/.test(name))) throw new Error("test_audio_manifest_invalid");
  return { init, segment: media.at(-1), sequence: Number(sequence), segments: media.length };
}

async function readRegular(file, maximum) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new Error("test_audio_file_invalid");
    const bytes = Buffer.alloc(stat.size), result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== bytes.length) throw new Error("test_audio_file_changed");
    return { bytes, ageMs: Math.max(0, Date.now() - stat.mtimeMs) };
  } finally { await handle.close(); }
}

function decodeLevels(fragment) {
  return new Promise(resolve => {
    const child = execFile("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "pipe", "-f", "mp4", "-i", "pipe:0",
      "-vn", "-t", "1", "-ar", "48000", "-ac", "2", "-f", "s16le", "pipe:1"],
    { timeout: 5000, maxBuffer: 262144, encoding: "buffer" }, (error, bytes) => {
      if (error || bytes.length < 4 || bytes.length % 4) { resolve({ decoded: false }); return; }
      const sums = [0, 0];
      for (let i = 0; i < bytes.length; i += 2) sums[(i / 2) % 2] += (bytes.readInt16LE(i) / 32768) ** 2;
      resolve({ decoded: true, samples: bytes.length / 4, channels: sums.map(sum => Math.sqrt(sum / (bytes.length / 4))) });
    });
    child.stdin.on("error", () => {}); child.stdin.end(fragment);
  });
}

/** Read only the single resource in this private synthetic fixture. No raw output. */
export async function nativeAudioOutputObservation(root) {
  try {
    const resources = (await fs.readdir(root, { withFileTypes: true })).filter(e => e.isDirectory() && /^res_[A-Za-z0-9_-]{16,64}$/.test(e.name));
    if (resources.length !== 1) return { available: false };
    const resource = path.join(root, resources[0].name);
    const rendition = (await fs.readdir(resource, { withFileTypes: true })).filter(e => e.isDirectory() && ["low", "medium", "high"].includes(e.name));
    if (rendition.length !== 1) return { available: false };
    const observe = async parts => {
      try {
        let directory = resource;
        for (const part of parts) {
          directory = path.join(directory, part);
          if (!(await fs.lstat(directory)).isDirectory()) throw new Error();
        }
        const manifest = await readRegular(path.join(directory, "index.m3u8"), 65536);
        const names = nativeAudioFragmentNames(manifest.bytes.toString("utf8"));
        const init = await readRegular(path.join(directory, names.init), 65536);
        const segment = await readRegular(path.join(directory, names.segment), 4 * 1024 * 1024);
        return { available: true, sequence: names.sequence, segments: names.segments, ageMs: manifest.ageMs,
          segmentBytes: segment.bytes.length, audio: await decodeLevels(Buffer.concat([init.bytes, segment.bytes])) };
      } catch { return { available: false }; }
    };
    return { available: true, committed: await observe([rendition[0].name]), producer: await observe([".pending", rendition[0].name]) };
  } catch { return { available: false }; }
}
