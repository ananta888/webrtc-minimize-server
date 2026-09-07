import { Injectable, OnDestroy } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { MachineMediaPublication } from "./machine-media-publication";

@Injectable()
export class MachineMediaSessionService implements OnDestroy {
  readonly publication: MachineMediaPublication;
  constructor(private readonly session: RoomSessionService, private readonly mesh: PeerMeshService) {
    this.publication = new MachineMediaPublication({ authority: () => {
      const lease = session.machineLease(), own = mesh.ownPeerId();
      if (!session.joined() || !lease || !mesh.machineReceive.isMachine(own)) throw new Error("machine_media_denied");
      return { sessionId: lease.sessionId, generation: lease.generation, expiresAt: lease.expiresAt,
        avatar: mesh.machineReceive.supports(own, "avatar.publish"), speech: mesh.machineReceive.supports(own, "speech.publish") };
    }, transportReady: () => mesh.mediaE2eeState() === "active" && mesh.overlayReady(), create: bytes => {
      const video = document.createElement("video") as HTMLVideoElement & { captureStream(): MediaStream };
      if (typeof video.captureStream !== "function") throw new Error("machine_media_unsupported");
      const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
      let stream: MediaStream | null = null;
      const attached: ("camera" | "microphone")[] = [];
      video.src = url; video.preload = "auto";
      return { ready: () => video.readyState >= 2,
        metadata: () => ({ duration: video.duration, width: video.videoWidth, height: video.videoHeight }),
        attach: outputs => {
          stream = video.captureStream();
          // Ignore, stop and never attach unselected tracks from the synthetic container.
          for (const [output, source, tracks] of [
            ["avatar", "camera", stream.getVideoTracks()], ["speech", "microphone", stream.getAudioTracks()],
          ] as const) {
            if (!outputs.includes(output)) { tracks.forEach(track => track.stop()); continue; }
            if (tracks.length !== 1) throw new Error("machine_media_tracks_missing");
            attached.push(source); mesh.attachPublication(source, new MediaStream(tracks));
          }
        }, play: () => video.play(), ended: () => video.ended, failed: () => Boolean(video.error),
        close: () => {
          video.pause(); stream?.getTracks().forEach(track => track.stop());
          for (const source of attached) mesh.detachPublication(source);
          video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url);
        } };
    } });
  }
  /** Additive v2 endpoint: explicit owned source and independent output rights; no implicit chat. */
  publish(input: unknown): Promise<void> {
    const keys = ["schema", "sourceId", "outputs", "mp4Base64"];
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("machine_media_request_invalid");
    const value = input as Record<string, unknown>, context = this.session.machineContext();
    if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
      || value["schema"] !== "ananta.meet-media-source.v1" || !context
      || value["sourceId"] !== "media:" + context.hubSessionId) throw new Error("machine_media_source_denied");
    return this.publication.publish(value["mp4Base64"], value["outputs"]);
  }
  ngOnDestroy(): void { this.publication.close(); }
}
