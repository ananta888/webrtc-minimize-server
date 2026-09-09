import type { PeerMeshService } from "../../webrtc/peer-mesh.service";
import type { MachineScreenSurface } from "./machine-screen-source";
import type { SourceTimingPort } from "./machine-media-timing.service";
import type { SourceTimingLease } from "./machine-media-timeline";

/** Own synthetic canvas only; no human capture and no independent restart. */
export function createMachineScreenSurface(
  mesh: Pick<PeerMeshService, "attachPublication" | "detachPublication">,
  timingPort?: SourceTimingPort,
): MachineScreenSurface {
  const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
  let stream: MediaStream | undefined, attached = false, closed = false;
  let timing: SourceTimingLease | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    timing?.close();
    try {
      stream?.getTracks().forEach(track => track.stop());
      if (attached) mesh.detachPublication("screen");
    } finally { canvas.width = canvas.height = 0; }
  };
  try {
    timing = timingPort?.open("screen", "canvas-submission", close);
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
      frame: () => { requireActive(); track.requestFrame(); timing?.observe(null); }, close };
  } catch (error) { close(); throw error; }
}
