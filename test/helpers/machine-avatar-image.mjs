// Deterministic minimal RGBA PNG. Only the private avatar browser test uses it.
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

function chunk(kind, data) {
  const type = Buffer.from(kind), content = Buffer.concat([type, data]);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, content, checksum]);
}

export function syntheticAvatarImage([red, green, blue]) {
  const header = Buffer.alloc(13); header.writeUInt32BE(8, 0); header.writeUInt32BE(8, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(8 * 33);
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) pixels.set([red, green, blue, 255], row * 33 + 1 + col * 4);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
  return { png: png.toString("base64"), sha256: createHash("sha256").update(png).digest("hex") };
}

export async function openTestImageAvatar({ sourceId, image }) {
  window.__avatarTestPulse?.stop();
  const source = window.anantaMachine.avatar, pending = source.open(sourceId, "persona-image-v1", image);
  const generation = source.status().generation;
  const controller = { timer: null, stop() { clearInterval(this.timer); } };
  window.__avatarTestPulse = controller;
  controller.timer = setInterval(() => { try { source.pulse(generation); } catch { controller.stop(); } }, 1000);
  try { return await pending; } catch (error) { controller.stop(); throw error; }
}
