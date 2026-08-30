import { ChangeDetectionStrategy, Component, OnDestroy, effect, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";

import { PeerMeshService } from "../webrtc/peer-mesh.service";
import { RoomSessionService } from "../webrtc/room-session.service";
import { PairWorkspaceService } from "./pair-workspace.service";

interface ReceivedArtifact {
  readonly id: number;
  readonly name: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
  readonly from: string;
}

@Component({
  selector: "app-pair-workspace-panel",
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (session.mode() === 'pair' && session.joined()) {
      <section class="panel pair-workspace" aria-labelledby="pair-workspace-heading">
        <div class="section-heading">
          <div><p class="eyebrow">Verschlüsselter Pair-Pfad</p><h2 id="pair-workspace-heading">{{ workspace.workspace()?.title || 'Pair-Austausch' }}</h2></div>
          <span class="counter">{{ session.workspaceRole() || 'flüchtig' }}</span>
        </div>
        <p id="overlay-path-status" class="hint">Schlüsselkanal: {{ mesh.overlayReady() ? 'bereit' : 'wartet' }}. Datenpfad: {{ mesh.overlayMode() }}. Persistente Hub-Events: {{ session.workspaceId() ? 'aktiv' : 'aus' }}.</p>
        @if (session.workspaceId()) {
          <div class="presence-actions">
            <button type="button" class="secondary" (click)="workspace.setPresence('active')">Aktiv</button>
            <button type="button" class="secondary" (click)="workspace.setPresence('away')">Abwesend</button>
            <button type="button" class="secondary" (click)="refresh()">Aktualisieren</button>
          </div>
          <div class="workspace-timeline" aria-live="polite">
            @for (event of workspace.events(); track event.sequence) {
              <article class="workspace-event" (click)="workspace.setCursor(event.sequence)">
                <strong>#{{ event.sequence }} · {{ event.kind }}</strong>
                <span>{{ event.payload['text'] || event.payload['name'] || event.digest.slice(0, 12) }}</span>
              </article>
            } @empty { <p class="hint">Noch keine dauerhaften Ereignisse.</p> }
          </div>
          <form class="chat-form" (submit)="$event.preventDefault(); addNote()">
            <input maxlength="2000" name="workspaceNote" placeholder="Entscheidung oder Notiz" [disabled]="workspace.workspace()?.role === 'viewer'" [ngModel]="note()" (ngModelChange)="note.set($event)">
            <button type="submit" class="primary" [disabled]="!note().trim() || workspace.workspace()?.role === 'viewer'">Speichern</button>
          </form>
        }
        @if (mesh.peerChoices().length > 0) {
          <div class="artifact-send">
            <label>Datei bis 768 KiB<input id="artifact-file" type="file" (change)="selectFile($event)"></label>
            <button id="send-artifact" type="button" [disabled]="!selectedFile() || !mesh.overlayReady()" (click)="sendArtifact()">Ende-zu-Ende senden</button>
          </div>
        }
        @for (artifact of artifacts(); track artifact.id) {
          <div class="received-artifact" data-received-artifact>
            <span>{{ artifact.name }} · {{ artifact.bytes.byteLength }} Bytes</span>
            <button type="button" class="secondary" (click)="download(artifact)">Explizit herunterladen</button>
          </div>
        }
        @if (transferStatus()) { <p id="artifact-status" class="hint">{{ transferStatus() }}</p> }
        @if (workspace.error() || transferError()) { <div class="error">{{ workspace.error() || transferError() }}</div> }
      </section>
    }
  `,
})
export class PairWorkspacePanelComponent implements OnDestroy {
  readonly note = signal("");
  readonly selectedFile = signal<File | null>(null);
  readonly artifacts = signal<readonly ReceivedArtifact[]>([]);
  readonly transferError = signal("");
  readonly transferStatus = signal("");
  private lastDeliveryId = 0;
  private artifactSerial = 0;
  private readonly workspaceLoader = effect(() => {
    const workspaceId = this.session.workspaceId();
    if (workspaceId && this.workspace.workspace()?.workspaceId !== workspaceId) void this.workspace.load(workspaceId);
    if (!workspaceId) this.workspace.clear();
  });
  private readonly deliveryReader = effect(() => {
    for (const delivery of this.mesh.overlayDeliveries()) {
      if (delivery.id <= this.lastDeliveryId) continue;
      this.lastDeliveryId = delivery.id;
      try {
        const envelope = JSON.parse(new TextDecoder().decode(delivery.data)) as Record<string, unknown>;
        if (envelope["version"] !== 1 || envelope["type"] !== "artifact"
          || typeof envelope["name"] !== "string" || typeof envelope["mime"] !== "string"
          || typeof envelope["bytes"] !== "string") continue;
        const binary = atob(envelope["bytes"] as string);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        if (bytes.byteLength > 768 * 1024) continue;
        this.artifacts.update((items) => [...items.slice(-15), {
          id: ++this.artifactSerial,
          name: (envelope["name"] as string).slice(0, 160),
          mime: (envelope["mime"] as string).slice(0, 120),
          bytes,
          from: delivery.originPeerId,
        }]);
        void this.workspace.load(this.session.workspaceId());
      } catch { /* malformed plaintext envelope */ }
    }
  });

  constructor(
    readonly session: RoomSessionService,
    readonly mesh: PeerMeshService,
    readonly workspace: PairWorkspaceService,
  ) {}

  ngOnDestroy(): void {
    this.workspaceLoader.destroy();
    this.deliveryReader.destroy();
    void this.workspace.setPresence("offline");
  }

  async refresh(): Promise<void> {
    await this.workspace.load(this.session.workspaceId());
  }

  async addNote(): Promise<void> {
    const text = this.note().trim();
    if (!text) return;
    if (await this.workspace.append("note", { text })) {
      this.note.set("");
      const peerId = this.mesh.peerChoices()[0]?.id;
      if (peerId) void this.mesh.sendOverlayData(peerId, new TextEncoder().encode(JSON.stringify({ version: 1, type: "workspace-refresh" })), "event");
    }
  }

  selectFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0] || null;
    this.transferError.set(file && file.size > 768 * 1024 ? "Datei überschreitet 768 KiB" : "");
    this.selectedFile.set(file && file.size <= 768 * 1024 ? file : null);
  }

  async sendArtifact(): Promise<void> {
    const file = this.selectedFile();
    const peerId = this.mesh.peerChoices()[0]?.id;
    if (!file || !peerId) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const envelope = new TextEncoder().encode(JSON.stringify({
      version: 1, type: "artifact", name: file.name.slice(0, 160), mime: file.type.slice(0, 120), bytes: btoa(binary),
    }));
    const sent = await this.mesh.sendOverlayData(peerId, envelope, "bulk");
    if (!sent) {
      this.transferError.set("Verschlüsselter Peer-Pfad ist noch nicht bereit");
      return;
    }
    await this.workspace.append("artifact", { name: file.name.slice(0, 160), bytes: file.size, peerDelivered: true });
    this.transferStatus.set("Verschlüsselt an den Peer gesendet");
    this.selectedFile.set(null);
  }

  download(artifact: ReceivedArtifact): void {
    const blob = new Blob([artifact.bytes.slice().buffer], { type: artifact.mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = artifact.name || "artifact.bin";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
