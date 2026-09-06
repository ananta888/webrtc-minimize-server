import { Component, OnDestroy, effect, inject } from "@angular/core";
import { RuntimeConfigService } from "../../core/runtime-config.service";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";

/** Dedicated automation endpoint. No messaging listener, human capture or OIDC shortcut. */
@Component({
  selector: "app-machine-page", standalone: true,
  template: `<main><h1>Ananta (KI)</h1><p>Autorisierter Maschinenclient für synthetische Quellen.</p>
    <p>{{ session.joined() ? 'Verbunden' : 'Nicht verbunden' }}</p>
    <button type="button" (click)="leave()">Sofort verlassen</button></main>`,
})
export class MachinePageComponent implements OnDestroy {
  readonly session = inject(RoomSessionService);
  private readonly config = inject(RuntimeConfigService);
  private readonly mesh = inject(PeerMeshService);
  private video?: HTMLVideoElement;
  private stream?: MediaStream;
  private objectUrl = "";
  private expiry?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private readonly api = {
    join: (roomId: string, grant: string) => this.join(roomId, grant),
    publish: (text: string, videoBase64: string) => this.publish(text, videoBase64),
    leave: () => this.leave(),
    status: () => ({ joined: this.session.joined(), peers: this.mesh.participantCount(),
      e2ee: this.mesh.mediaE2eeState(), chat: this.mesh.chat() }),
  };

  constructor() {
    // Accessible only to code running in this isolated browser context (e.g. Playwright).
    Object.defineProperty(window, "anantaMachine", { configurable: true, value: this.api });
    effect(() => { if (!this.session.joined() && this.video) this.stopMedia(); });
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
    this.expiry = setTimeout(() => this.leave(), Math.max(1, this.session.machineExpiresAt() - Date.now()));
    await this.until(() => this.session.joined(), generation);
  }

  private async publish(text: string, encoded: string): Promise<void> {
    if (!this.session.joined() || this.video || typeof text !== "string" || !text.trim() || text.length > 450
        || typeof encoded !== "string" || encoded.length > 4_700_000) throw new Error("machine_publication_invalid");
    const generation = this.generation;
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    if (String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp") throw new Error("machine_media_invalid");
    const video = document.createElement("video") as HTMLVideoElement & { captureStream(): MediaStream };
    this.video = video;
    this.objectUrl = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
    video.src = this.objectUrl; video.preload = "auto";
    try {
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
      this.stopMedia();
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

  private stopMedia(): void {
    this.video?.pause();
    this.stream?.getTracks().forEach(track => track.stop());
    this.mesh.detachPublication("camera"); this.mesh.detachPublication("microphone");
    if (this.video) { this.video.removeAttribute("src"); this.video.load(); }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.video = undefined; this.stream = undefined; this.objectUrl = "";
  }

  leave(): void {
    ++this.generation; clearTimeout(this.expiry);
    try { this.stopMedia(); } finally { this.session.leave(); this.mesh.clearChatHistory(); }
  }

  ngOnDestroy(): void {
    this.leave(); Reflect.deleteProperty(window, "anantaMachine");
  }
}
