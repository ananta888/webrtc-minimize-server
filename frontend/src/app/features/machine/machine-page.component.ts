import { Component, OnDestroy, effect, inject } from "@angular/core";
import { MachineLeaseExpiry } from "./machine-lease-expiry";
import { MachinePageLifecycle } from "./machine-page-lifecycle";
import { MachineClientProbe, probeMachineClient } from "./machine-client-probe";
import { RuntimeConfigService } from "../../core/runtime-config.service";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { MachineChatSessionService } from "./machine-chat-session.service";
import { MachineAudioSessionService } from "./machine-audio-session.service";
import { MachineVisualSessionService } from "./machine-visual-session.service";
import { MachinePublicationOwnership } from "./machine-publication-ownership";
import { MachineSpeechGraphFactory } from "./machine-speech-graph";
import { MachineSpeechSessionService } from "./machine-speech-session.service";
import { MachineAvatarSurfaceFactory } from "./machine-avatar-surface";
import { MachineAvatarSessionService } from "./machine-avatar-session.service";
import { MachineScreenSessionService } from "./machine-screen-session.service";
import { MachineMediaSessionService } from "./machine-media-session.service";
import { MachineScreenAudioSessionService } from "./machine-screen-audio-session.service";

/** Dedicated automation endpoint. No messaging listener, human capture or OIDC shortcut. */
@Component({
  selector: "app-machine-page", standalone: true,
  providers: [MachineChatSessionService, MachineAudioSessionService, MachineVisualSessionService, MachineScreenSessionService, MachineMediaSessionService, MachineScreenAudioSessionService,
    MachinePublicationOwnership, MachineSpeechGraphFactory, MachineSpeechSessionService, MachineAvatarSurfaceFactory, MachineAvatarSessionService],
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
  private readonly machineVisual = inject(MachineVisualSessionService);
  private readonly machineScreen = inject(MachineScreenSessionService);
  private readonly machineSpeech = inject(MachineSpeechSessionService);
  private readonly machineAvatar = inject(MachineAvatarSessionService);
  private readonly machineMedia = inject(MachineMediaSessionService);
  private readonly machineScreenAudio = inject(MachineScreenAudioSessionService);
  private readonly expiry = new MachineLeaseExpiry(() => this.session.machineExpiresAt(), () => this.leave());
  private readonly lifecycle = new MachinePageLifecycle({
    load: () => this.config.load(),
    join: (roomId, grant) => this.session.join(roomId, "Ananta (KI)", "room", grant),
    joined: () => this.session.joined(),
    cleanup: [() => this.expiry.close(), () => this.session.leave(),
      () => this.machineAvatar.source.close(), () => this.machineSpeech.source.close(),
      () => this.machineScreenAudio.source.close(), () => this.machineScreen.source.close(),
      () => this.machineAudio.close(), () => this.machineVisual.close(),
      () => this.machineChat.endpoint.close(), () => this.machineMedia.publication.close(),
      () => this.mesh.clearChatHistory()],
    cleanupFailed: () => this.session.error.set("machine_cleanup_failed"),
  });
  private readonly api = {
    join: (roomId: string, grant: string) => this.lifecycle.join(roomId, grant),
    renew: (grant: string) => this.session.renewMachine(grant),
    capabilities: () => Object.freeze({ schema: "ananta.meet-capabilities.v1", publication: "mp4-v1",
      sessionLease: "ananta.meet-session-lease.v1", chatEvents: false, audioSubscription: false, screenPublication: false }),
    probe: (): MachineClientProbe => probeMachineClient(this.api),
    publish: (text: string, videoBase64: string) => this.publish(text, videoBase64),
    media: Object.freeze({ publish: (input: unknown) => this.machineMedia.publish(input),
      close: () => this.machineMedia.publication.close(), status: () => this.machineMedia.publication.status() }),
    chat: Object.freeze({ open: () => this.machineChat.endpoint.open(),
      poll: () => this.machineChat.endpoint.poll(), ack: (cursor: number) => this.machineChat.endpoint.ack(cursor),
      reply: (messageId: string, text: string) => this.machineChat.endpoint.reply(messageId, text),
      close: () => this.machineChat.endpoint.close(), status: () => this.machineChat.endpoint.status() }),
    audio: Object.freeze({ sources: () => this.machineAudio.sources(),
      segmentProbe: () => this.machineAudio.segmentProbe(),
      finish: (subscriptionId: string, endSample: number) => this.machineAudio.finish(subscriptionId, endSample),
      open: (publicationId: string, seconds?: number) => this.machineAudio.open(publicationId, seconds),
      poll: () => this.machineAudio.poll(), ack: (sequence: number) => this.machineAudio.ack(sequence),
      reply: (subscriptionId: string, text: string) => this.machineAudio.reply(subscriptionId, text),
      close: () => this.machineAudio.close(), status: () => this.machineAudio.status() }),
    visual: Object.freeze({ probe: () => this.machineVisual.probe(), sources: () => this.machineVisual.sources(),
      open: (publicationId: string) => this.machineVisual.open(publicationId),
      frame: (subscriptionId: string) => this.machineVisual.frame(subscriptionId),
      close: () => this.machineVisual.close(), status: () => this.machineVisual.status() }),
    screen: Object.freeze({ open: (sourceId: string) => { this.machineScreenAudio.source.close(); return this.machineScreen.source.open(sourceId); },
      push: (generation: number, sequence: number, jpeg: string) => this.machineScreen.source.push(generation, sequence, jpeg),
      close: () => { this.machineScreenAudio.source.close(); this.machineScreen.source.close(); }, status: () => this.machineScreen.source.status(),
      diagnostics: () => this.machineScreen.source.diagnostics() }),
    screenAudio: Object.freeze({ open: (sourceId: string) => this.machineScreenAudio.source.open(sourceId),
      push: (generation: number, sequence: number, pcm: string) => this.machineScreenAudio.source.push(generation, sequence, pcm),
      close: () => this.machineScreenAudio.source.close(), status: () => this.machineScreenAudio.source.status() }),
    speech: Object.freeze({ open: (sourceId: string, samples: number) => this.machineSpeech.source.open(sourceId, samples),
      push: (generation: number, startSample: number, pcm: string) => this.machineSpeech.source.push(generation, startSample, pcm),
      close: () => this.machineSpeech.source.close(), status: () => this.machineSpeech.source.status() }),
    avatar: Object.freeze({ open: (sourceId: string, profile: string, image?: unknown) => this.machineAvatar.source.open(sourceId, profile, image),
      videoProbe: () => this.machineAvatar.videoProbe(),
      pulse: (generation: number) => this.machineAvatar.source.pulse(generation),
      close: (generation?: number) => this.machineAvatar.source.close(generation), status: () => this.machineAvatar.source.status() }),
    leave: () => this.leave(),
    status: () => ({ joined: this.session.joined(), peers: this.mesh.participantCount(),
      lease: this.session.machineLease(),
      e2ee: this.mesh.mediaE2eeState(), chat: this.mesh.chat() }),
  };

  constructor() {
    // Accessible only to code running in this isolated browser context (e.g. Playwright).
    Object.defineProperty(window, "anantaMachine", { configurable: true, value: this.api });
    effect(() => { if (!this.session.joined()) this.machineMedia.publication.close(); });
    effect(() => {
      const expiry = this.session.machineExpiresAt();
      this.expiry.arm(expiry);
    });
  }

  private async publish(text: string, encoded: string): Promise<void> {
    const own = this.mesh.ownPeerId();
    if (!["avatar.publish", "speech.publish", "chat.send"].every(capability => this.mesh.machineReceive.supports(own, capability))) {
      throw new Error("machine_publication_capability_denied");
    }
    if (typeof text !== "string" || !text.trim() || text.length > 450) throw new Error("machine_publication_invalid");
    await this.machineMedia.publication.publish(encoded, ["avatar", "speech"], () => this.mesh.sendChat(text));
  }

  leave(): void { this.lifecycle.leave(); }

  ngOnDestroy(): void {
    this.lifecycle.destroy(); Reflect.deleteProperty(window, "anantaMachine");
  }
}
