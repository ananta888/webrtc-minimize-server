import { Injectable } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { MachinePublicationClaim, MachinePublicationOwnership } from "./machine-publication-ownership";
import { MachineAvatarSurface } from "./machine-avatar-source";
import { drawAvatar, MachineAvatarArtwork } from "./machine-avatar-artwork";
import { MachineMediaTimingService } from "./machine-media-timing.service";
import { SourceTimingLease } from "./machine-media-timeline";

interface CameraPublication {
  canvas: HTMLCanvasElement; drawing: CanvasRenderingContext2D; stream: MediaStream;
  track: CanvasCaptureMediaStreamTrack; claim: MachinePublicationClaim;
}
/** A closed generation's live camera publication kept attached for a successor. */
interface ParkedPublication extends CameraPublication {
  grace: ReturnType<typeof setTimeout>; bound: ReturnType<typeof setTimeout>; expired: boolean;
}
// A close followed by the next open (state or clip change) must not detach
// and re-attach the camera: a new track id forces renegotiation and a fresh
// SFrame key exchange per swap. Keep the publication briefly, longer only while
// a successor decoder is actually loading, never past a bounded ceiling.
const HANDOVER_GRACE_MS = 500, HANDOVER_BOUND_MS = 10_000;

/** Own synthetic canvas only; optional decoded artwork has no URL/capture port. */
@Injectable()
export class MachineAvatarSurfaceFactory {
  private parked?: ParkedPublication;
  private holds = 0;

  constructor(private readonly mesh: PeerMeshService, private readonly ownership: MachinePublicationOwnership,
    private readonly timing: MachineMediaTimingService) {}

  /** Keep the last closed camera attached until released, so the next generation adopts it. */
  hold(): () => void {
    let held = true; this.holds++;
    return () => {
      if (!held) return; held = false; this.holds--;
      if (this.holds === 0 && this.parked?.expired) this.flush();
    };
  }

  create(artwork?: MachineAvatarArtwork): MachineAvatarSurface {
    const adopted = this.adopt();
    const claim = adopted?.claim ?? this.ownership.claim(["camera"]);
    let live: CameraPublication | undefined = adopted;
    let canvas: HTMLCanvasElement | undefined = adopted?.canvas, stream: MediaStream | undefined = adopted?.stream;
    let closed = false, attached = Boolean(adopted);
    let timing: SourceTimingLease | undefined;
    const release = (action: () => void) => { try { action(); } catch { /* Continue releasing owned resources. */ } };
    const close = (failed = false) => {
      if (closed) return; closed = true;
      timing?.close();
      release(() => artwork?.close());
      if (!failed && attached && live && live.track.readyState === "live" && claim.owns("camera")) { this.park(live); return; }
      stream?.getTracks().forEach(track => release(() => track.stop()));
      if (attached && claim.owns("camera")) release(() => this.mesh.detachPublication("camera"));
      release(() => { if (canvas) canvas.width = canvas.height = 0; });
      claim.release();
    };
    try {
      timing = this.timing.open("avatar", artwork?.mediaTiming ? "decoded-video" : "canvas-submission", () => close());
      if (!live) {
        canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
        const drawing = canvas.getContext("2d", { alpha: false });
        if (!drawing || typeof canvas.captureStream !== "function") throw new Error("meet_avatar_unsupported");
        drawAvatar(drawing, 0, artwork);
        stream = canvas.captureStream(0);
        const tracks = stream.getTracks(), track = tracks[0] as CanvasCaptureMediaStreamTrack;
        if (tracks.length !== 1 || track.kind !== "video" || typeof track.requestFrame !== "function") throw new Error("meet_avatar_unsupported");
        track.contentHint = "detail";
        attached = true; this.mesh.attachPublication("camera", stream);
        live = { canvas, drawing, stream, track, claim };
      } else drawAvatar(live.drawing, 0, artwork);
      const { drawing, track } = live;
      const mediaPosition = () => {
        try { return artwork?.mediaTiming?.(); }
        catch (error) { timing!.fail(); throw error; }
      };
      const ready = () => !closed && claim.owns("camera") && track.readyState === "live"
        && this.mesh.localPublicationProtected(track) && this.mesh.overlayReady()
        && mediaPosition() !== null;
      return { ready, frame: sequence => {
        if (!ready()) throw new Error("meet_avatar_not_ready");
        const position = mediaPosition();
        if (position === null) throw new Error("meet_avatar_not_ready");
        drawAvatar(drawing, sequence, artwork); track.requestFrame();
        timing!.observe(position?.positionUs ?? null, position?.held ?? false);
      }, close: () => close() };
    } catch (error) { close(true); throw error; }
  }

  private park(entry: CameraPublication): void {
    this.flush();
    const parked: ParkedPublication = { ...entry, expired: false,
      grace: setTimeout(() => { parked.expired = true; if (this.holds === 0) this.flush(); }, HANDOVER_GRACE_MS),
      bound: setTimeout(() => this.flush(), HANDOVER_BOUND_MS) };
    this.parked = parked;
    // An unrelated camera claimant (MP4 publication) takes over unless a successor avatar is loading.
    parked.claim.park(() => { if (this.holds > 0 || this.parked !== parked) return false; this.flush(); return true; });
  }

  private adopt(): CameraPublication | undefined {
    const parked = this.parked;
    if (!parked) return undefined;
    this.parked = undefined; clearTimeout(parked.grace); clearTimeout(parked.bound); parked.claim.resume();
    if (parked.track.readyState === "live" && parked.claim.owns("camera")) return parked;
    this.discard(parked); return undefined;
  }

  private flush(): void {
    const parked = this.parked;
    if (!parked) return;
    this.parked = undefined; clearTimeout(parked.grace); clearTimeout(parked.bound);
    this.discard(parked);
  }

  private discard(parked: CameraPublication): void {
    const release = (action: () => void) => { try { action(); } catch { /* Continue releasing owned resources. */ } };
    parked.stream.getTracks().forEach(track => release(() => track.stop()));
    if (parked.claim.owns("camera")) release(() => this.mesh.detachPublication("camera"));
    release(() => { parked.canvas.width = parked.canvas.height = 0; });
    parked.claim.release();
  }
}
