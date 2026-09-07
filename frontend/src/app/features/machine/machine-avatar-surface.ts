import { Injectable } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { MachinePublicationOwnership } from "./machine-publication-ownership";
import { MachineAvatarSurface } from "./machine-avatar-source";
import { drawAvatar, MachineAvatarArtwork } from "./machine-avatar-artwork";

/** Own synthetic canvas only; optional decoded artwork has no URL/capture port. */
@Injectable()
export class MachineAvatarSurfaceFactory {
  constructor(private readonly mesh: PeerMeshService, private readonly ownership: MachinePublicationOwnership) {}

  create(artwork?: MachineAvatarArtwork): MachineAvatarSurface {
    const claim = this.ownership.claim(["camera"]);
    let canvas: HTMLCanvasElement | undefined, stream: MediaStream | undefined;
    let closed = false, attached = false;
    const release = (action: () => void) => { try { action(); } catch { /* Continue releasing owned resources. */ } };
    const close = () => {
      if (closed) return; closed = true;
      stream?.getTracks().forEach(track => release(() => track.stop()));
      if (attached && claim.owns("camera")) release(() => this.mesh.detachPublication("camera"));
      release(() => { if (canvas) canvas.width = canvas.height = 0; });
      release(() => artwork?.close());
      claim.release();
    };
    try {
      canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
      const drawing = canvas.getContext("2d", { alpha: false });
      if (!drawing || typeof canvas.captureStream !== "function") throw new Error("meet_avatar_unsupported");
      drawAvatar(drawing, 0, artwork);
      stream = canvas.captureStream(0);
      const tracks = stream.getTracks(), track = tracks[0] as CanvasCaptureMediaStreamTrack;
      if (tracks.length !== 1 || track.kind !== "video" || typeof track.requestFrame !== "function") throw new Error("meet_avatar_unsupported");
      track.contentHint = "detail";
      attached = true; this.mesh.attachPublication("camera", stream);
      const ready = () => !closed && claim.owns("camera") && track.readyState === "live"
        && this.mesh.localPublicationProtected(track) && this.mesh.overlayReady();
      return { ready, frame: sequence => {
        if (!ready()) throw new Error("meet_avatar_not_ready");
        drawAvatar(drawing, sequence, artwork); track.requestFrame();
      }, close };
    } catch (error) { close(); throw error; }
  }
}
