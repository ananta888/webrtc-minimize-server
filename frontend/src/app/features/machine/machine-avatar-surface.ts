import { Injectable } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { MachinePublicationOwnership } from "./machine-publication-ownership";
import { MachineAvatarSurface } from "./machine-avatar-source";
import { drawAvatar, MachineAvatarArtwork } from "./machine-avatar-artwork";
import { MachineMediaTimingService } from "./machine-media-timing.service";
import { SourceTimingLease } from "./machine-media-timeline";

/** Own synthetic canvas only; optional decoded artwork has no URL/capture port. */
@Injectable()
export class MachineAvatarSurfaceFactory {
  constructor(private readonly mesh: PeerMeshService, private readonly ownership: MachinePublicationOwnership,
    private readonly timing: MachineMediaTimingService) {}

  create(artwork?: MachineAvatarArtwork): MachineAvatarSurface {
    const claim = this.ownership.claim(["camera"]);
    let canvas: HTMLCanvasElement | undefined, stream: MediaStream | undefined;
    let closed = false, attached = false;
    let timing: SourceTimingLease | undefined;
    const release = (action: () => void) => { try { action(); } catch { /* Continue releasing owned resources. */ } };
    const close = () => {
      if (closed) return; closed = true;
      timing?.close();
      stream?.getTracks().forEach(track => release(() => track.stop()));
      if (attached && claim.owns("camera")) release(() => this.mesh.detachPublication("camera"));
      release(() => { if (canvas) canvas.width = canvas.height = 0; });
      release(() => artwork?.close());
      claim.release();
    };
    try {
      timing = this.timing.open("avatar", artwork?.mediaTiming ? "decoded-video" : "canvas-submission", close);
      canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
      const drawing = canvas.getContext("2d", { alpha: false });
      if (!drawing || typeof canvas.captureStream !== "function") throw new Error("meet_avatar_unsupported");
      drawAvatar(drawing, 0, artwork);
      stream = canvas.captureStream(0);
      const tracks = stream.getTracks(), track = tracks[0] as CanvasCaptureMediaStreamTrack;
      if (tracks.length !== 1 || track.kind !== "video" || typeof track.requestFrame !== "function") throw new Error("meet_avatar_unsupported");
      track.contentHint = "detail";
      attached = true; this.mesh.attachPublication("camera", stream);
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
      }, close };
    } catch (error) { close(); throw error; }
  }
}
