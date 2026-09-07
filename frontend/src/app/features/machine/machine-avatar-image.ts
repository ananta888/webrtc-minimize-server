import { MachineAvatarArtwork } from "./machine-avatar-artwork";
import { MachineAvatarSurface } from "./machine-avatar-source";

const MAX_BYTES = 5 * 1024 * 1024;
interface ImagePorts {
  create(artwork: MachineAvatarArtwork): MachineAvatarSurface;
  decode?: (blob: Blob) => Promise<ImageBitmap>;
  digest?: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
  clock?: () => number;
}

/** Decode at most one immutable PNG, even if an unabortable browser call stalls. */
export class MachineAvatarImageLoader {
  private decoding = false;
  constructor(private readonly ports: ImagePorts) {}

  create(value: unknown, check: () => void): MachineAvatarSurface {
    if (this.decoding) throw new Error("meet_avatar_image_decoder_busy");
    const { bytes, sha256, width, height } = parseAvatarImage(value);
    const clock = this.ports.clock ?? Date.now, started = clock(), deadline = started + 1000;
    let closed = false, failure: Error | undefined, surface: MachineAvatarSurface | undefined;
    const close = () => {
      if (closed) return; closed = true;
      const owned = surface; surface = undefined;
      try { owned?.close(); } catch { /* The source is fenced even if a browser cleanup fails. */ }
    };
    const current = () => {
      const now = clock();
      if (closed || !Number.isFinite(now) || now < started || now >= deadline) throw new Error("meet_avatar_image_decode_expired");
      check();
    };
    current(); this.decoding = true;
    const load = async () => {
      let bitmap: ImageBitmap | undefined;
      try {
        const digest = this.ports.digest ?? digestImage;
        if (await digest(bytes) !== sha256) throw new Error("meet_avatar_image_digest_invalid");
        current();
        bitmap = await (this.ports.decode ?? createImageBitmap)(new Blob([bytes], { type: "image/png" }));
        current();
        if (bitmap.width !== width || bitmap.height !== height) throw new Error("meet_avatar_image_dimensions_invalid");
        const owned = bitmap;
        const scale = Math.min(160 / width, 128 / height), w = width * scale, h = height * scale;
        // Artwork cannot cover the fixed header, KI label or liveness strip.
        surface = this.ports.create({ draw: drawing => drawing.drawImage(owned, (256 - w) / 2, 40 + (128 - h) / 2, w, h),
          close: () => owned.close() });
        bitmap = undefined; // Surface now owns the decoded image.
      } catch (error) {
        failure = error instanceof Error ? error : new Error("meet_avatar_image_failed");
        try { bitmap?.close(); } catch { /* Still release the source and decoder permit. */ }
        close();
      } finally { this.decoding = false; }
    };
    void load();
    return { ready: () => {
      if (failure) throw failure;
      if (closed) return false;
      if (!surface) { try { current(); } catch (error) { close(); throw error; } return false; }
      return surface.ready();
    }, frame: sequence => {
      if (closed || !surface) throw new Error("meet_avatar_image_not_ready");
      surface.frame(sequence);
    }, close };
  }
}

export function parseAvatarImage(value: unknown): { bytes: Uint8Array<ArrayBuffer>; sha256: string; width: number; height: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "png,sha256") throw new Error("meet_avatar_image_invalid");
  const { png, sha256 } = value as Record<string, unknown>;
  if (typeof png !== "string" || !png.length || png.length > 4 * Math.ceil(MAX_BYTES / 3)
    || png.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(png)
    || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("meet_avatar_image_invalid");
  const raw = atob(png);
  if (raw.length < 33 || raw.length > MAX_BYTES || btoa(raw) !== png) throw new Error("meet_avatar_image_invalid");
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  const head = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
  const view = new DataView(bytes.buffer), width = view.getUint32(16), height = view.getUint32(20);
  if (head.some((byte, i) => bytes[i] !== byte) || bytes[24] !== 8 || bytes[25] !== 6
    || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0 || width < 1 || height < 1 || width > 1024 || height > 1024) {
    throw new Error("meet_avatar_image_dimensions_invalid");
  }
  // Only the normalized static PNG structure emitted by Ananta's image worker.
  // Reject animation, metadata, trailing data and duplicate headers before decode.
  let offset = 33, dataSeen = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), end = offset + 12 + length;
    const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (end > bytes.length || (kind !== "IDAT" && kind !== "IEND") || (kind === "IEND" && (length !== 0 || !dataSeen || end !== bytes.length))) {
      throw new Error("meet_avatar_image_chunks_invalid");
    }
    if (kind === "IDAT") dataSeen = true;
    else ended = true;
    offset = end;
  }
  if (!ended || offset !== bytes.length) throw new Error("meet_avatar_image_chunks_invalid");
  return { bytes, sha256, width, height };
}

async function digestImage(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}
