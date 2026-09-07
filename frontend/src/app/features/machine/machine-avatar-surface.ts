import { Injectable } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { MachinePublicationOwnership } from "./machine-publication-ownership";
import { MachineAvatarSurface } from "./machine-avatar-source";

/** Own synthetic canvas only. No external assets, capture devices or inference. */
@Injectable()
export class MachineAvatarSurfaceFactory {
  constructor(private readonly mesh: PeerMeshService, private readonly ownership: MachinePublicationOwnership) {}

  create(): MachineAvatarSurface {
    const claim = this.ownership.claim(["camera"]);
    let canvas: HTMLCanvasElement | undefined, stream: MediaStream | undefined;
    let closed = false, attached = false;
    const release = (action: () => void) => { try { action(); } catch { /* Continue releasing owned resources. */ } };
    const close = () => {
      if (closed) return; closed = true;
      stream?.getTracks().forEach(track => release(() => track.stop()));
      if (attached && claim.owns("camera")) release(() => this.mesh.detachPublication("camera"));
      release(() => { if (canvas) canvas.width = canvas.height = 0; });
      claim.release();
    };
    try {
      canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
      const drawing = canvas.getContext("2d", { alpha: false });
      if (!drawing || typeof canvas.captureStream !== "function") throw new Error("meet_avatar_unsupported");
      drawNeutralAvatar(drawing, 0);
      stream = canvas.captureStream(0);
      const tracks = stream.getTracks(), track = tracks[0] as CanvasCaptureMediaStreamTrack;
      if (tracks.length !== 1 || track.kind !== "video" || typeof track.requestFrame !== "function") throw new Error("meet_avatar_unsupported");
      track.contentHint = "detail";
      attached = true; this.mesh.attachPublication("camera", stream);
      const ready = () => !closed && claim.owns("camera") && track.readyState === "live"
        && this.mesh.localPublicationProtected(track) && this.mesh.overlayReady();
      return { ready, frame: sequence => {
        if (!ready()) throw new Error("meet_avatar_not_ready");
        drawNeutralAvatar(drawing, sequence); track.requestFrame();
      }, close };
    } catch (error) { close(); throw error; }
  }
}

function drawNeutralAvatar(drawing: CanvasRenderingContext2D, sequence: number): void {
  drawing.fillStyle = "#102638"; drawing.fillRect(0, 0, 256, 256);
  drawing.fillStyle = "#72e1ce";
  drawing.beginPath(); drawing.arc(128, 105, 57, 0, Math.PI * 2); drawing.fill();
  drawing.fillStyle = "#102638";
  drawing.fillRect(99, 94, 12, 12); drawing.fillRect(145, 94, 12, 12);
  drawing.fillRect(108, 125, 40, 5);
  drawing.fillStyle = "#ffffff"; drawing.textAlign = "center";
  drawing.font = "bold 20px sans-serif"; drawing.fillText("ANANTA / KI", 128, 202);
  // Visible low-rate liveness indicator; never represents real speech/lip sync.
  drawing.fillStyle = "#72e1ce"; drawing.fillRect(28, 224, 20 + (sequence % 10) * 20, 6);
}
