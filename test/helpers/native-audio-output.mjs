import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { probeSceneFragment } from "./native-scene-fragment-probe.mjs";
import { probeNativeVideoOutput } from "./native-video-output-probe.mjs";

export function nativeAudioFragmentNames(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 65536) throw new Error("test_audio_manifest_invalid");
  const init = text.match(/^#EXT-X-MAP:URI="(init(?:_[0-9]+)?\.mp4)"$/m)?.[1];
  const sequence = text.match(/^#EXT-X-MEDIA-SEQUENCE:([0-9]+)$/m)?.[1];
  const media = text.split(/\r?\n/).filter(line => line && !line.startsWith("#"));
  if (!init || sequence === undefined || !Number.isSafeInteger(Number(sequence)) || !media.length || media.length > 8
    || media.some(name => !/^segment_[0-9]{9}\.m4s$/.test(name))) throw new Error("test_audio_manifest_invalid");
  return { init, segment: media.at(-1), sequence: Number(sequence), segments: media.length };
}

export function nativeOutputMasterRenditions(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 65536 || !text.startsWith("#EXTM3U\n")) throw new Error("test_output_master_invalid");
  const lines = text.trimEnd().split("\n"), rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (/^#EXT-X-VERSION:[0-9]+$/.test(lines[i]) || lines[i] === "#EXT-X-INDEPENDENT-SEGMENTS") continue;
    const entry = /^#EXT-X-STREAM-INF:BANDWIDTH=([0-9]+),RESOLUTION=([0-9]+)x([0-9]+)$/.exec(lines[i]);
    const uri = /^(low|medium|high)\/index\.m3u8$/.exec(lines[++i] ?? "");
    if (!entry || !uri || rows.length >= 3 || rows.some(r => r.id === uri[1])) throw new Error("test_output_master_invalid");
    const [bandwidth, width, height] = entry.slice(1).map(Number);
    if (!Number.isSafeInteger(bandwidth) || bandwidth < 1 || bandwidth > 12000000
      || width < 160 || width > 1280 || height < 90 || height > 720) throw new Error("test_output_master_invalid");
    rows.push({ id: uri[1], width, height });
  }
  if (!rows.length) throw new Error("test_output_master_invalid");
  return rows;
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

function probeEncoding(fragment) {
  return new Promise(resolve => {
    const child = execFile("ffprobe", ["-v", "error", "-protocol_whitelist", "pipe", "-f", "mp4", "-i", "pipe:0",
      "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels,bit_rate", "-of", "json"],
    { timeout: 5000, maxBuffer: 4096, encoding: "utf8" }, (error, text) => {
      try {
        if (error) throw error;
        const streams = JSON.parse(text).streams;
        if (!Array.isArray(streams) || streams.length !== 1) throw new Error();
        const stream = streams[0], rate = Number(stream.bit_rate);
        if (stream.codec_name !== "aac" || stream.sample_rate !== "48000" || ![1, 2].includes(stream.channels)
          || !Number.isSafeInteger(rate) || rate < 1 || rate > 500000) throw new Error();
        resolve({ codec: "aac", sampleRate: 48000, channels: stream.channels, measuredBitsPerSecond: rate });
      } catch { resolve(null); }
    });
    child.stdin.on("error", () => {}); child.stdin.end(fragment);
  });
}

/** Read only the single resource in this private synthetic fixture. No raw output. */
export async function nativeAudioOutputObservation(root, { encoding = false, scene = false, video = false, renditionId, master = false } = {}) {
  if (renditionId !== undefined && !["low", "medium", "high"].includes(renditionId)) throw new Error("test_output_rendition_invalid");
  try {
    const resources = (await fs.readdir(root, { withFileTypes: true })).filter(e => e.isDirectory() && /^res_[A-Za-z0-9_-]{16,64}$/.test(e.name));
    if (resources.length !== 1) return { available: false };
    const resource = path.join(root, resources[0].name);
    const rendition = (await fs.readdir(resource, { withFileTypes: true })).filter(e => e.isDirectory() && ["low", "medium", "high"].includes(e.name));
    if (renditionId === undefined ? rendition.length !== 1 : !rendition.some(row => row.name === renditionId)) return { available: false };
    const selected = renditionId ?? rendition[0].name;
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
        const fragment = Buffer.concat([init.bytes, segment.bytes]);
        return { available: true, sequence: names.sequence, segments: names.segments, ageMs: manifest.ageMs,
          segmentBytes: segment.bytes.length, audio: await decodeLevels(fragment),
          ...(scene ? { scene: await probeSceneFragment(fragment) } : {}),
          ...(video ? { video: await probeNativeVideoOutput(fragment) } : {}),
          ...(encoding ? { encoding: await probeEncoding(fragment) } : {}) };
      } catch { return { available: false }; }
    };
    return { available: true, committed: await observe([selected]), producer: await observe([".pending", selected]),
      ...(master ? { master: nativeOutputMasterRenditions((await readRegular(path.join(resource, "index.m3u8"), 65536)).bytes.toString("utf8")) } : {}) };
  } catch { return { available: false }; }
}
