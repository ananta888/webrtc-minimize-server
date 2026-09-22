import { MachineAvatarArtwork } from "./machine-avatar-artwork";
import { MachineAvatarSurface } from "./machine-avatar-source";
import { AvatarVideoContent, parseAvatarVideo } from "./machine-avatar-video-contract";
import { AvatarVideoDecoder, decodeAvatarVideo } from "./machine-avatar-video-decoder";

interface VideoPorts {
  create(artwork: MachineAvatarArtwork): MachineAvatarSurface;
  hold?: () => () => void; // Keeps the previous camera publication attached while this clip loads.
  decode?: (content: AvatarVideoContent) => AvatarVideoDecoder;
  digest?: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
  clock?: () => number;
  timing?: () => boolean;
}

/** One content/decoder lifetime, composed with the existing independently fenced camera. */
export class MachineAvatarVideoLoader {
  // The single decoder permit: a clip's native play must settle before the
  // next decoder exists, so a swap waits for its predecessor instead of failing.
  private settled: Promise<void> = Promise.resolve();
  constructor(private readonly ports: VideoPorts) {}

  create(value: unknown, check: () => void): MachineAvatarSurface {
    const content = parseAvatarVideo(value), clock = this.ports.clock ?? Date.now, started = clock();
    const timed = this.ports.timing?.() === true;
    let closed = false, failure = false, pending = 1, decoder: AvatarVideoDecoder | undefined, surface: MachineAvatarSurface | undefined;
    let settle: () => void = () => undefined, held: (() => void) | undefined;
    const releasePermit = () => { if (closed && pending === 0) settle(); };
    const release = () => { const owned = held; held = undefined; owned?.(); };
    const close = () => {
      if (closed) return; closed = true; content.bytes.fill(0); release();
      const owned = surface; surface = undefined;
      try { owned?.close(); } catch { /* Still close decoder and release permit. */ }
      try { decoder?.close(); } catch { /* Source remains fenced. */ }
      releasePermit();
    };
    const deadline = () => {
      const now = clock();
      if (closed || !Number.isFinite(now) || now < started || now >= started + 2000) throw new Error("meet_avatar_video_decode_expired");
    };
    const current = () => { deadline(); check(); };
    try { current(); } catch (error) { content.bytes.fill(0); throw error; }
    const previous = this.settled;
    this.settled = new Promise<void>(resolve => { settle = resolve; });
    held = this.ports.hold?.();
    void (async () => {
      try {
        if (await (this.ports.digest ?? digestVideo)(content.bytes) !== content.sha256) throw new Error("meet_avatar_video_digest_invalid");
        await previous; // Never two native decoders; the deadline bounds a stalled predecessor.
        current(); decoder = this.ports.decode ? this.ports.decode(content) : decodeAvatarVideo(content, timed); content.bytes.fill(0);
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
        if (!surface) {
          deadline();
          // The authority fence belongs to the owning source: while this clip is
          // still attaching, a revoked scope reports "not ready" instead of
          // throwing, so the source's own guard decides whether the generation
          // ends. Only decode/digest failures and the decode deadline propagate.
          try { check(); } catch { return false; }
          if (!decoder?.ready()) return false;
          const owned = decoder;
          surface = this.ports.create({ ...(timed ? { mediaTiming: () => {
            if (!owned.timing) throw new Error("meet_avatar_video_timing_unsupported");
            return owned.timing();
          } } : {}), draw: drawing => {
            check(); owned.draw(drawing);
            drawing.fillStyle = "#ffffff"; drawing.font = "10px sans-serif"; drawing.textAlign = "center";
            drawing.fillText(content.classification === "production" ? "IMPORTED" : content.classification === "test_only" ? "TEST" : "SYNTH", 128, 183);
          }, close: () => owned.close() });
          release();
        }
        return decoder!.ready() && surface.ready();
      } catch (error) { close(); throw error; }
    }, diagnostics: () => {
      let surfaceParts: Record<string, unknown> = {};
      try { surfaceParts = surface?.diagnostics?.() ?? {}; } catch { /* surface diagnostics only */ }
      let decoderReady: unknown = "no-decoder";
      let decoderParts: Record<string, unknown> = {};
      if (decoder) {
        try { decoderReady = decoder.ready(); } catch (error) { decoderReady = "threw:" + String(error); }
        try { decoderParts = decoder.diagnostics?.() ?? {}; } catch { /* decoder diagnostics only */ }
      }
      // Distinct key: the loader's own flag must not shadow the surface's or the
      // decoder's identically named part in the merged diagnostics.
      return { ...surfaceParts, ...decoderParts, decoderReady, surfaceAttached: Boolean(surface), failure, loaderClosed: closed, pending };
    }, frame: sequence => {
      if (closed || !surface) throw new Error("meet_avatar_video_not_ready");
      try { check(); surface.frame(sequence); } catch (error) { close(); throw error; }
    }, close };
  }
}

async function digestVideo(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}
