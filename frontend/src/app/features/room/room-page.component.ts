import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, effect, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";

import { OidcAuthService } from "../../auth/oidc-auth.service";
import { RuntimeConfigService } from "../../core/runtime-config.service";
import { DeviceIdentityService } from "../../identity/device-identity.service";
import { MediaStreamDirective } from "../../shared/media-stream.directive";
import { MediaMosaicComponent } from "../../shared/media-mosaic.component";
import { OptimizationMode } from "../../webrtc/media-optimization-policy";
import { MediaPublicationService } from "../../webrtc/media-publication.service";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomMode, RoomSessionService } from "../../webrtc/room-session.service";
import { SignalingService } from "../../webrtc/signaling.service";
import { PairWorkspacePanelComponent } from "../../workspace/pair-workspace-panel.component";
import { PairWorkspaceService, WorkspaceSummary } from "../../workspace/pair-workspace.service";

@Component({
  selector: "app-room-page",
  standalone: true,
  imports: [FormsModule, MediaStreamDirective, MediaMosaicComponent, PairWorkspacePanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./room-page.component.html",
})
export class RoomPageComponent implements OnInit, OnDestroy {
  readonly ready = signal(false);
  readonly pageError = signal("");
  readonly roomInput = signal("");
  readonly nameInput = signal(sessionStorage.getItem("webrtc-display-name") || "");
  readonly selectedMode = signal<RoomMode>("room");
  readonly chatInput = signal("");
  readonly workspaceTitle = signal("Pair Dev Workspace");
  readonly connectionLabel = computed(() => {
    if (this.session.joined()) return "Signaling verbunden";
    if (this.signaling.status() === "connecting") return "Verbindung wird aufgebaut";
    if (this.signaling.status() === "error") return "Signaling fehlgeschlagen";
    return "Nicht verbunden";
  });
  readonly authRequired = computed(() => this.config.value()?.auth.mode === "required");
  readonly canEnter = computed(() => this.ready() && (!this.authRequired() || this.auth.authenticated()));
  private readonly beforeUnload = () => this.shutdown();
  private readonly stopCaptureOnSessionEnd = effect(() => {
    if (!this.session.joined() && this.signaling.status() !== "connecting") this.media.stopAll();
  });

  constructor(
    readonly config: RuntimeConfigService,
    readonly auth: OidcAuthService,
    readonly device: DeviceIdentityService,
    readonly signaling: SignalingService,
    readonly session: RoomSessionService,
    readonly mesh: PeerMeshService,
    readonly media: MediaPublicationService,
    readonly workspaces: PairWorkspaceService,
  ) {}

  async ngOnInit(): Promise<void> {
    window.addEventListener("beforeunload", this.beforeUnload);
    const params = new URLSearchParams(location.search);
    this.roomInput.set(params.get("room") || "");
    this.selectedMode.set(params.get("mode") === "pair" ? "pair" : "room");
    this.session.setWorkspaceInvite(params.get("workspaceInvite") || "");
    try {
      this.auth.configure(await this.config.load());
      if (this.auth.authenticated() && this.config.value()?.pairWorkspaceEnabled) void this.workspaces.loadList();
      this.ready.set(true);
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "Konfiguration konnte nicht geladen werden");
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener("beforeunload", this.beforeUnload);
    this.stopCaptureOnSessionEnd.destroy();
    this.shutdown();
  }

  async create(mode: RoomMode): Promise<void> {
    try {
      const room = await this.session.createRoom(mode);
      this.roomInput.set(room.roomId);
      this.selectedMode.set(mode);
      history.replaceState(null, "", `/?room=${encodeURIComponent(room.roomId)}&mode=${mode}`);
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "Raum konnte nicht erstellt werden");
    }
  }

  async createWorkspace(): Promise<void> {
    try {
      const room = await this.session.createRoom("pair", true, this.workspaceTitle());
      this.roomInput.set(room.roomId);
      this.selectedMode.set("pair");
      history.replaceState(null, "", new URL(room.inviteUrl).search);
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "Workspace konnte nicht erstellt werden");
    }
  }

  selectWorkspace(workspace: Omit<WorkspaceSummary, "members">): void {
    this.roomInput.set(workspace.roomId);
    this.selectedMode.set("pair");
    this.session.setWorkspaceInvite("");
    history.replaceState(null, "", `/?room=${encodeURIComponent(workspace.roomId)}&mode=pair`);
  }

  async join(): Promise<void> {
    this.pageError.set("");
    const name = this.nameInput().trim();
    const room = this.roomInput().trim();
    if (!name || !room) {
      this.pageError.set("Name und Raumcode fehlen");
      return;
    }
    sessionStorage.setItem("webrtc-display-name", name);
    try {
      await this.session.join(room, name, this.selectedMode());
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "Beitritt fehlgeschlagen");
    }
  }

  leave(): void {
    this.media.stopAll();
    this.session.leave();
  }

  async logout(): Promise<void> {
    this.leave();
    await this.auth.logout();
  }

  async copyInvite(): Promise<void> {
    if (this.session.inviteUrl()) await navigator.clipboard.writeText(this.session.inviteUrl());
  }

  sendChat(): void {
    this.mesh.sendChat(this.chatInput());
    this.chatInput.set("");
  }

  setOptimizationMode(mode: OptimizationMode): void {
    this.mesh.setOptimizationMode(mode);
  }

  setRelayConsent(enabled: boolean): void {
    try {
      this.mesh.setRelayConsent(enabled);
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "relay_consent_failed");
    }
  }

  mediaLabel(source: string): string {
    return ({ microphone: "Mikrofon", camera: "Kamera", screen: "Bildschirm", "screen-audio": "Bildschirmton" } as Record<string, string>)[source] || source;
  }

  private shutdown(): void {
    this.media.stopAll();
    this.session.leave();
  }
}
