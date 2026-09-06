import { Injectable, OnDestroy } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { MachineScreenSource } from "./machine-screen-source";

@Injectable()
export class MachineScreenSessionService implements OnDestroy {
  readonly source: MachineScreenSource;
  constructor(private readonly session: RoomSessionService, private readonly mesh: PeerMeshService) {
    this.source = new MachineScreenSource({ authority: () => {
      const context = session.machineContext(), lease = session.machineLease();
      if (!session.joined() || !context || !lease || !mesh.machineReceive.supports(mesh.ownPeerId(), "screen.publish")) {
        throw new Error("meet_screen_source_denied");
      }
      return { sourceId: "screen:" + context.hubSessionId, sessionId: lease.sessionId, leaseGeneration: lease.generation,
        membershipEpoch: mesh.membershipEpoch(), expiresAt: lease.expiresAt };
    }, create: () => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
      const drawing = canvas.getContext("2d", { alpha: false });
      if (!drawing || typeof canvas.captureStream !== "function") throw new Error("meet_screen_unsupported");
      drawing.fillStyle = "black"; drawing.fillRect(0, 0, 640, 360);
      // Only this synthetic canvas, never getDisplayMedia or a human browser tab.
      const stream = canvas.captureStream(0), track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
      if (!track || typeof track.requestFrame !== "function") { stream.getTracks().forEach(t => t.stop()); throw new Error("meet_screen_unsupported"); }
      track.contentHint = "detail";
      try { mesh.attachPublication("screen", stream); }
      catch (error) { stream.getTracks().forEach(t => t.stop()); throw error; }
      return { draw: bitmap => drawing.drawImage(bitmap, 0, 0), frame: () => track.requestFrame(),
        close: () => { stream.getTracks().forEach(t => t.stop()); mesh.detachPublication("screen");
          drawing.clearRect(0, 0, 640, 360); canvas.width = canvas.height = 0; } };
    }, decode: bytes => createImageBitmap(new Blob([bytes], { type: "image/jpeg" })) });
  }
  ngOnDestroy(): void { this.source.close(); }
}
