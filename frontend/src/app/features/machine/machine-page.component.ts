import { Component, OnDestroy, effect, inject } from "@angular/core";
import { MachineLeaseExpiry } from "./machine-lease-expiry";
import { RuntimeConfigService } from "../../core/runtime-config.service";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { MachineChatSessionService } from "./machine-chat-session.service";
import { MachineAudioSessionService } from "./machine-audio-session.service";
import { MachineScreenSessionService } from "./machine-screen-session.service";
import { MachinePublicationClaim, MachinePublicationOwnership } from "./machine-publication-ownership";
import { MachineSpeechGraphFactory } from "./machine-speech-graph";
import { MachineSpeechSessionService } from "./machine-speech-session.service";
import { MachineAvatarSurfaceFactory } from "./machine-avatar-surface";
import { MachineAvatarSessionService } from "./machine-avatar-session.service";

/** Dedicated automation endpoint. No messaging listener, human capture or OIDC shortcut. */
@Component({
  selector: "app-machine-page", standalone: true,
  providers: [MachineChatSessionService, MachineAudioSessionService, MachineScreenSessionService, MachinePublicationOwnership,
    MachineSpeechGraphFactory, MachineSpeechSessionService, MachineAvatarSurfaceFactory, MachineAvatarSessionService],
  template: `<main><h1>Ananta (KI)</h1><p>Autorisierter Maschinenclient für synthetische Quellen.</p>
    <p>{{ session.joined() ? 'Verbunden' : 'Nicht verbunden' }}</p>
    <button type="button" (click)="leave()">Sofort verlassen</button></main>`,
})
export class MachinePageComponent implements OnDestroy {
  readonly session = inject(RoomSessionService);
  private readonly config = inject(RuntimeConfigService);
  private readonly mesh = inject(PeerMeshService);
  private readonly machineChat = inject(MachineChatSessionService);
  private readonly machineAudio = inject(MachineAudioSessionService);
  private readonly machineScreen = inject(MachineScreenSessionService);
  private readonly machineSpeech = inject(MachineSpeechSessionService);
  private readonly machineAvatar = inject(MachineAvatarSessionService);
  private readonly publicationOwnership = inject(MachinePublicationOwnership);
  private publicationClaim?: MachinePublicationClaim;
  private video?: HTMLVideoElement;
  private stream?: MediaStream;
  private objectUrl = "";
  private readonly expiry = new MachineLeaseExpiry(() => this.session.machineExpiresAt(), () => this.leave());
  private generation = 0;
  private readonly api = {
    join: (roomId: string, grant: string) => this.join(roomId, grant),
    renew: (grant: string) => this.session.renewMachine(grant),
    capabilities: () => Object.freeze({ schema: "ananta.meet-capabilities.v1", publication: "mp4-v1",
      sessionLease: "ananta.meet-session-lease.v1", chatEvents: false, audioSubscription: false, screenPublication: false }),
    publish: (text: string, videoBase64: string) => this.publish(text, videoBase64),
    chat: Object.freeze({ open: () => this.machineChat.endpoint.open(),
      poll: () => this.machineChat.endpoint.poll(), ack: (cursor: number) => this.machineChat.endpoint.ack(cursor),
      reply: (messageId: string, text: string) => this.machineChat.endpoint.reply(messageId, text),
      close: () => this.machineChat.endpoint.close(), status: () => this.machineChat.endpoint.status() }),
    audio: Object.freeze({ sources: () => this.machineAudio.sources(),
      open: (publicationId: string, seconds?: number) => this.machineAudio.open(publicationId, seconds),
      poll: () => this.machineAudio.poll(), ack: (sequence: number) => this.machineAudio.ack(sequence),
      reply: (subscriptionId: string, text: string) => this.machineAudio.reply(subscriptionId, text),
      close: () => this.machineAudio.close(), status: () => this.machineAudio.status() }),
    screen: Object.freeze({ open: (sourceId: string) => this.machineScreen.source.open(sourceId),
      push: (generation: number, sequence: number, jpeg: string) => this.machineScreen.source.push(generation, sequence, jpeg),
      close: () => this.machineScreen.source.close(), status: () => this.machineScreen.source.status() }),
    speech: Object.freeze({ open: (sourceId: string, samples: number) => this.machineSpeech.source.open(sourceId, samples),
      push: (generation: number, startSample: number, pcm: string) => this.machineSpeech.source.push(generation, startSample, pcm),
      close: () => this.machineSpeech.source.close(), status: () => this.machineSpeech.source.status() }),
    avatar: Object.freeze({ open: (sourceId: string, profile: string) => this.machineAvatar.source.open(sourceId, profile),
      close: (generation?: number) => this.machineAvatar.source.close(generation), status: () => this.machineAvatar.source.status() }),
    leave: () => this.leave(),
    status: () => ({ joined: this.session.joined(), peers: this.mesh.participantCount(),
      lease: this.session.machineLease(),
      e2ee: this.mesh.mediaE2eeState(), chat: this.mesh.chat() }),
  };

  constructor() {
    // Accessible only to code running in this isolated browser context (e.g. Playwright).
    Object.defineProperty(window, "anantaMachine", { configurable: true, value: this.api });
    effect(() => { if (!this.session.joined() && this.video) this.stopMedia(); });
    effect(() => {
      const expiry = this.session.machineExpiresAt();
      this.expiry.arm(expiry);
    });
  }

  private async join(roomId: string, grant: string): Promise<void> {
    this.leave();
    if (typeof grant !== "string" || grant.length > 4096 || !/^room-[a-f0-9]{18}$/.test(roomId)) {
      throw new Error("machine_join_invalid");
    }
    const generation = this.generation;
    await this.config.load();
    if (generation !== this.generation) throw new Error("machine_cancelled");
    await this.session.join(roomId, "Ananta (KI)", "room", grant);
    if (generation !== this.generation) { this.session.leave(); throw new Error("machine_cancelled"); }
    await this.until(() => this.session.joined(), generation);
  }

  private async publish(text: string, encoded: string): Promise<void> {
    const own = this.mesh.ownPeerId();
    if (!["avatar.publish", "speech.publish", "chat.send"].every(capability => this.mesh.machineReceive.supports(own, capability))) {
      throw new Error("machine_publication_capability_denied");
    }
    if (!this.session.joined() || this.video || typeof text !== "string" || !text.trim() || text.length > 450
        || typeof encoded !== "string" || encoded.length > 4_700_000) throw new Error("machine_publication_invalid");
    const generation = this.generation;
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    if (String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp") throw new Error("machine_media_invalid");
    const claim = this.publicationOwnership.claim(["camera", "microphone"]);
    this.publicationClaim = claim;
    try {
      const video = document.createElement("video") as HTMLVideoElement & { captureStream(): MediaStream };
      this.video = video;
      this.objectUrl = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
      video.src = this.objectUrl; video.preload = "auto";
      await this.until(() => video.readyState >= 2, generation);
      if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 40) {
        throw new Error("machine_media_duration_invalid");
      }
      this.stream = video.captureStream();
      if (this.stream.getVideoTracks().length !== 1 || this.stream.getAudioTracks().length !== 1) {
        throw new Error("machine_media_tracks_missing");
      }
      this.mesh.attachPublication("camera", new MediaStream(this.stream.getVideoTracks()));
      this.mesh.attachPublication("microphone", new MediaStream(this.stream.getAudioTracks()));
      await this.until(() => this.mesh.mediaE2eeState() === "active" && this.mesh.overlayReady(), generation);
      this.mesh.sendChat(text);
      await video.play();
      await this.until(() => video.ended, generation, 45_000);
    } finally {
      this.stopMedia(claim);
    }
  }

  private async until(ready: () => boolean, generation: number, budget = 20_000): Promise<void> {
    const deadline = Date.now() + budget;
    while (!ready()) {
      if (generation !== this.generation || Date.now() >= deadline) throw new Error("machine_operation_bounded_stop");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (generation !== this.generation) throw new Error("machine_cancelled");
  }

  private stopMedia(expected?: MachinePublicationClaim): void {
    if (expected && this.publicationClaim !== expected) return;
    const claim = this.publicationClaim;
    this.publicationClaim = undefined;
    try {
      this.video?.pause();
      this.stream?.getTracks().forEach(track => track.stop());
      if (claim?.owns("camera")) this.mesh.detachPublication("camera");
      if (claim?.owns("microphone")) this.mesh.detachPublication("microphone");
      if (this.video) { this.video.removeAttribute("src"); this.video.load(); }
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    } finally {
      this.video = undefined; this.stream = undefined; this.objectUrl = "";
      claim?.release();
    }
  }

  leave(): void {
    this.machineAvatar.source.close();
    this.machineSpeech.source.close();
    this.machineScreen.source.close();
    this.machineAudio.close();
    this.machineChat.endpoint.close();
    ++this.generation; this.expiry.close();
    try { this.stopMedia(); } finally { this.session.leave(); this.mesh.clearChatHistory(); }
  }

  ngOnDestroy(): void {
    this.leave(); Reflect.deleteProperty(window, "anantaMachine");
  }
}
