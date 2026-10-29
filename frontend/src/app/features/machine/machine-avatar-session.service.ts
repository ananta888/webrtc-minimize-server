import { Injectable, OnDestroy } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { MachineAvatarSource } from "./machine-avatar-source";
import { MachineAvatarSurfaceFactory } from "./machine-avatar-surface";
import { MachineAvatarImageLoader } from "./machine-avatar-image";
import { MachineAvatarVideoLoader } from "./machine-avatar-video";
import { probeAvatarVideo } from "./machine-avatar-video-contract";
import { MachineMediaTimingService } from "./machine-media-timing.service";
import { AvatarSequenceController } from "./machine-avatar-sequence-controller";
import { AvatarSequencePreparation } from "./machine-avatar-sequence-preparation";
import { decodeAvatarSequenceClip } from "./machine-avatar-sequence-decoder";

@Injectable()
export class MachineAvatarSessionService implements OnDestroy {
  readonly source: MachineAvatarSource;
  readonly videoProbe = probeAvatarVideo;
  readonly sequences: AvatarSequenceController;
  private speechProgress?: () => unknown;
  constructor(session: RoomSessionService, mesh: PeerMeshService, surfaces: MachineAvatarSurfaceFactory, timing: MachineMediaTimingService) {
    const images = new MachineAvatarImageLoader({ create: artwork => surfaces.create(artwork), hold: () => surfaces.hold() });
    const videos = new MachineAvatarVideoLoader({ create: artwork => surfaces.create(artwork), hold: () => surfaces.hold(),
      timing: () => timing.enabled() });
    const authority = () => {
      const context = session.machineContext(), lease = session.machineLease();
      if (!session.joined() || !context || !lease || !mesh.machineReceive.supports(mesh.ownPeerId(), "avatar.publish")) {
        throw new Error("meet_avatar_source_denied");
      }
      return { sourceId: "avatar:" + context.hubSessionId, sessionId: lease.sessionId, leaseGeneration: lease.generation,
        membershipEpoch: mesh.membershipEpoch(), expiresAt: lease.expiresAt };
    };
    this.sequences = new AvatarSequenceController({ authority,
      progress: () => {
        if (!this.speechProgress) throw new Error("meet_avatar_sequence_speech_unavailable");
        return this.speechProgress();
      }, preparation: new AvatarSequencePreparation({
        digest: async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          value => value.toString(16).padStart(2, "0")).join(""),
        decode: decodeAvatarSequenceClip,
      }) });
    this.source = new MachineAvatarSource({ authority, create: (profile, content, check) =>
      profile === "neutral-ai-v1" ? surfaces.create()
        : profile === "persona-sequence-v1" ? surfaces.create(this.sequences.activate(content, check))
          : profile === "persona-video-v1" ? videos.create(content, check) : images.create(content, check) });
  }
  bindSpeechProgress(progress: () => unknown): void {
    if (this.speechProgress || typeof progress !== "function") throw new Error("meet_avatar_sequence_progress_binding_invalid");
    this.speechProgress = progress;
  }
  sequenceProbe() {
    return Object.freeze({ schema: "ananta.meet-avatar-sequence-probe.v1", profile: "persona-sequence-v1",
      supported: Boolean(this.speechProgress) && typeof createImageBitmap === "function" && this.videoProbe().mp4H264 });
  }
  ngOnDestroy(): void { this.source.close(); this.sequences.close(); }
}
