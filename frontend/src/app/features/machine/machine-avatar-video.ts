import { MachineAvatarArtwork } from "./machine-avatar-artwork";
import { MachineAvatarSurface } from "./machine-avatar-source";
import { AvatarVideoContent, parseAvatarVideo } from "./machine-avatar-video-contract";
import { AvatarVideoDecoder, decodeAvatarVideo } from "./machine-avatar-video-decoder";

interface VideoPorts {
  create(artwork: MachineAvatarArtwork): MachineAvatarSurface;
  decode?: (content: AvatarVideoContent) => AvatarVideoDecoder;
  digest?: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
  clock?: () => number;
}

/** One content/decoder lifetime, composed with the existing independently fenced camera. */
export class MachineAvatarVideoLoader {
  private busy = false;
  constructor(private readonly ports: VideoPorts) {}

  create(value: unknown, check: () => void): MachineAvatarSurface {
    if (this.busy) throw new Error("meet_avatar_video_decoder_busy");
    const content = parseAvatarVideo(value), clock = this.ports.clock ?? Date.now, started = clock();
    let closed = false, failure = false, pending = 1, decoder: AvatarVideoDecoder | undefined, surface: MachineAvatarSurface | undefined;
    const releasePermit = () => { if (closed && pending === 0) this.busy = false; };
    const close = () => {
      if (closed) return; closed = true; content.bytes.fill(0);
      const owned = surface; surface = undefined;
      try { owned?.close(); } catch { /* Still close decoder and release permit. */ }
      try { decoder?.close(); } catch { /* Source remains fenced. */ }
      releasePermit();
    };
    const current = () => {
      const now = clock();
      if (closed || !Number.isFinite(now) || now < started || now >= started + 2000) throw new Error("meet_avatar_video_decode_expired");
      check();
    };
    try { current(); } catch (error) { content.bytes.fill(0); throw error; }
    this.busy = true;
    void (async () => {
      try {
        if (await (this.ports.digest ?? digestVideo)(content.bytes) !== content.sha256) throw new Error("meet_avatar_video_digest_invalid");
        current(); decoder = (this.ports.decode ?? decodeAvatarVideo)(content); content.bytes.fill(0);
        pending++;
        void decoder.settled.then(() => { pending--; releasePermit(); }, () => {
          pending--; failure = true; close(); releasePermit();
        });
      } catch { failure = true; close(); }
      finally { pending--; releasePermit(); }
    })();
    return { ready: () => {
      if (failure) throw new Error("meet_avatar_video_failed");
      if (closed) return false;
      try {
        check();
        if (!surface) {
          current();
          if (!decoder?.ready()) return false;
          const owned = decoder;
          surface = this.ports.create({ draw: drawing => {
            check(); owned.draw(drawing);
            drawing.fillStyle = "#ffffff"; drawing.font = "10px sans-serif"; drawing.textAlign = "center";
            drawing.fillText(content.classification === "production" ? "IMPORTED" : content.classification === "test_only" ? "TEST" : "SYNTH", 128, 183);
          }, close: () => owned.close() });
        }
        return decoder!.ready() && surface.ready();
      } catch (error) { close(); throw error; }
    }, frame: sequence => {
      if (closed || !surface) throw new Error("meet_avatar_video_not_ready");
      try { check(); surface.frame(sequence); } catch (error) { close(); throw error; }
    }, close };
  }
}

async function digestVideo(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}
