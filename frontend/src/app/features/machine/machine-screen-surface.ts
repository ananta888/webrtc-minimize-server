import type { PeerMeshService } from "../../webrtc/peer-mesh.service";
import type { MachineScreenSurface } from "./machine-screen-source";

/** Own synthetic canvas only; no human capture and no independent restart. */
export function createMachineScreenSurface(
  mesh: Pick<PeerMeshService, "attachPublication" | "detachPublication">,
): MachineScreenSurface {
  const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
  let stream: MediaStream | undefined, attached = false, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      stream?.getTracks().forEach(track => track.stop());
      if (attached) mesh.detachPublication("screen");
    } finally { canvas.width = canvas.height = 0; }
  };
  try {
    const drawing = canvas.getContext("2d", { alpha: false });
    if (!drawing || typeof canvas.captureStream !== "function") throw new Error("meet_screen_unsupported");
    drawing.fillStyle = "black"; drawing.fillRect(0, 0, 640, 360);
    stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
    if (!track || track.readyState !== "live" || typeof track.requestFrame !== "function") {
      throw new Error("meet_screen_unsupported");
    }
    track.contentHint = "detail";
    // Mark before attach: partial attach failures must also remove this publication.
    attached = true; mesh.attachPublication("screen", stream);
    const active = () => !closed && stream?.active === true && track.readyState === "live";
    const requireActive = () => { if (!active()) throw new Error("meet_screen_source_ended"); };
    return { active, draw: bitmap => { requireActive(); drawing.drawImage(bitmap, 0, 0); },
      frame: () => { requireActive(); track.requestFrame(); }, close };
  } catch (error) { close(); throw error; }
}
