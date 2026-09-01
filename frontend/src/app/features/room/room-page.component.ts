import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, effect, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";

import { OidcAuthService } from "../../auth/oidc-auth.service";
import { RuntimeConfigService } from "../../core/runtime-config.service";
import { DeviceIdentityService } from "../../identity/device-identity.service";
import {
  RoomDirectoryService,
  RoomSummary,
  RoomVisibility,
} from "../../rooms/room-directory.service";
import { MediaControlBarComponent } from "../../shared/media-control-bar.component";
import { MediaStreamDirective } from "../../shared/media-stream.directive";
import { MediaMosaicComponent } from "../../shared/media-mosaic.component";
import { OptimizationMode } from "../../webrtc/media-optimization-policy";
import { MediaPublicationService } from "../../webrtc/media-publication.service";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomMode, RoomSessionService } from "../../webrtc/room-session.service";
import { SignalingService } from "../../webrtc/signaling.service";
import { VideoCapturePreferencesService, VideoCaptureSource } from "../../webrtc/video-capture-preferences.service";
import { PairWorkspacePanelComponent } from "../../workspace/pair-workspace-panel.component";
import { PairWorkspaceService, WorkspaceSummary } from "../../workspace/pair-workspace.service";

type AppSection = "rooms" | "live" | "chat" | "settings";

@Component({
  selector: "app-room-page",
  standalone: true,
  imports: [
    FormsModule,
    MediaControlBarComponent,
    MediaStreamDirective,
    MediaMosaicComponent,
    PairWorkspacePanelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./room-page.component.html",
})
export class RoomPageComponent implements OnInit, OnDestroy {
  readonly ready = signal(false);
  readonly pageError = signal("");
  readonly notice = signal("");
  readonly activeSection = signal<AppSection>("rooms");
  readonly roomInput = signal("");
  readonly nameInput = signal(sessionStorage.getItem("webrtc-display-name") || "");
  readonly selectedMode = signal<RoomMode>("room");
  readonly newRoomTitle = signal("Meine Runde");
  readonly newRoomVisibility = signal<RoomVisibility>("private");
  readonly chatInput = signal("");
  readonly workspaceTitle = signal("Pair Dev Workspace");
  readonly connectionLabel = computed(() => {
    if (this.session.joined()) return "Signaling verbunden";
    if (this.signaling.status() === "connecting") return "Verbindung wird aufgebaut";
    if (this.signaling.status() === "error") return "Verbindung fehlgeschlagen";
    return "Nicht verbunden";
  });
  readonly authRequired = computed(() => this.config.value()?.auth.mode === "required");
  readonly canEnter = computed(() => this.ready() && (!this.authRequired() || this.auth.authenticated()));
  readonly canOwnRooms = computed(() => this.auth.authenticated());
  readonly currentRoom = computed(() => {
    const roomId = this.session.joined() ? this.session.roomId() : this.roomInput();
    return [...this.directory.ownRooms(), ...this.directory.publicRooms()]
      .find((room) => room.roomId === roomId) || null;
  });
  readonly currentRoomTitle = computed(() => (
    this.currentRoom()?.title
    || (this.session.mode() === "pair" ? "Pair-Session" : "Privater Raum")
  ));
  readonly combinedError = computed(() => (
    this.pageError()
    || this.directory.error()
    || this.session.error()
    || this.media.error()
    || this.auth.error()
  ));
  private directoryRefreshHandle: ReturnType<typeof setInterval> | null = null;
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
    readonly videoPreferences: VideoCapturePreferencesService,
    readonly directory: RoomDirectoryService,
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
      if (!this.nameInput().trim() && this.auth.username()) this.nameInput.set(this.auth.username());
      this.ready.set(true);
      await Promise.all([
        this.directory.load(),
        this.auth.authenticated() && this.config.value()?.pairWorkspaceEnabled
          ? this.workspaces.loadList()
          : Promise.resolve(),
      ]);
      this.directoryRefreshHandle = setInterval(() => {
        if (document.visibilityState === "visible") void this.directory.load();
      }, 15_000);
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "Konfiguration konnte nicht geladen werden");
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener("beforeunload", this.beforeUnload);
    if (this.directoryRefreshHandle) clearInterval(this.directoryRefreshHandle);
    this.stopCaptureOnSessionEnd.destroy();
    this.shutdown();
  }

  show(section: AppSection): void {
    this.activeSection.set(section);
  }

  async createRoom(): Promise<void> {
    this.clearMessages();
    const title = this.newRoomTitle().trim();
    if (!title) {
      this.pageError.set("Bitte gib dem Raum einen Titel.");
      return;
    }
    try {
      const room = await this.directory.create(title, this.newRoomVisibility());
      if (!room.roomId || !room.inviteUrl) throw new Error("room_creation_invalid");
      this.roomInput.set(room.roomId);
      this.selectedMode.set("room");
      this.session.setWorkspaceInvite("");
      history.replaceState(null, "", `/?room=${encodeURIComponent(room.roomId)}&mode=room`);
      await this.directory.load();
      this.notice.set(`„${room.title || title}“ wurde erstellt.`);
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "Raum konnte nicht erstellt werden");
    }
  }

  async create(mode: RoomMode): Promise<void> {
    this.clearMessages();
    try {
      const room = await this.session.createRoom(mode);
      this.roomInput.set(room.roomId);
      this.selectedMode.set(mode);
      history.replaceState(null, "", `/?room=${encodeURIComponent(room.roomId)}&mode=${mode}`);
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "Session konnte nicht erstellt werden");
    }
  }

  async createWorkspace(): Promise<void> {
    this.clearMessages();
    try {
      const room = await this.session.createRoom("pair", true, this.workspaceTitle());
      this.roomInput.set(room.roomId);
      this.selectedMode.set("pair");
      history.replaceState(null, "", new URL(room.inviteUrl).search);
      await this.workspaces.loadList();
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

  async enterListedRoom(room: RoomSummary): Promise<void> {
    await this.enterRoom(room.roomId, "room", { clearWorkspaceInvite: true });
  }

  async join(): Promise<void> {
    await this.enterRoom(this.roomInput(), this.selectedMode(), {
      clearWorkspaceInvite: this.selectedMode() === "room",
    });
  }

  leave(): void {
    this.media.stopAll();
    this.session.leave();
    this.notice.set("Du hast den Raum verlassen.");
    this.activeSection.set("rooms");
    void this.directory.load();
  }

  async logout(): Promise<void> {
    this.media.stopAll();
    this.session.leave();
    this.activeSection.set("rooms");
    this.directory.clearOwnRooms();
    await this.auth.logout();
  }

  async setVisibility(room: RoomSummary, visibility: RoomVisibility): Promise<void> {
    if (!room.owned || room.visibility === visibility) return;
    this.clearMessages();
    try {
      const updated = await this.directory.update(room.roomId, { visibility });
      this.notice.set(updated.visibility === "public"
        ? `„${updated.title}“ ist jetzt öffentlich sichtbar.`
        : `„${updated.title}“ ist jetzt nur noch per Einladung sichtbar.`);
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "Sichtbarkeit konnte nicht geändert werden");
    }
  }

  async toggleCurrentVisibility(): Promise<void> {
    const room = this.currentRoom();
    if (room?.owned) await this.setVisibility(room, room.visibility === "public" ? "private" : "public");
  }

  async refreshRooms(): Promise<void> {
    await this.directory.load();
  }

  async copyInvite(): Promise<void> {
    const value = this.session.inviteUrl();
    if (value) await this.copy(value);
  }

  async copyRoomInvite(room: RoomSummary): Promise<void> {
    await this.copy(`${location.origin}/?room=${encodeURIComponent(room.roomId)}&mode=room`);
  }

  sendChat(): void {
    this.mesh.sendChat(this.chatInput());
    this.chatInput.set("");
  }

  setOptimizationMode(mode: OptimizationMode): void {
    this.mesh.setOptimizationMode(mode);
  }

  setVideoResolution(source: VideoCaptureSource, resolutionId: unknown): void {
    void this.media.setVideoResolution(source, resolutionId);
  }

  setVideoFrameRate(source: VideoCaptureSource, frameRate: unknown): void {
    void this.media.setVideoFrameRate(source, frameRate);
  }

  setScreenAudioEnabled(enabled: unknown): void {
    this.media.setScreenAudioEnabled(enabled);
  }

  screenAudioStatus(): string {
    if (this.media.screenAudioActive()) return "aktiv";
    if (this.media.active("screen") && this.videoPreferences.screenAudioEnabled()) {
      return "vom Browser nicht bereitgestellt";
    }
    return this.videoPreferences.screenAudioEnabled() ? "beim nächsten Teilen angefordert" : "aus";
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

  private async enterRoom(
    roomId: string,
    mode: RoomMode,
    options: { clearWorkspaceInvite: boolean },
  ): Promise<void> {
    this.clearMessages();
    const room = roomId.trim().toLowerCase();
    const name = (this.nameInput().trim() || this.auth.username()).trim();
    if (!name || !room) {
      this.pageError.set("Name und Raumcode fehlen.");
      this.activeSection.set("rooms");
      return;
    }
    if (this.session.joined() && this.session.roomId() === room && this.session.mode() === mode) {
      this.activeSection.set("live");
      return;
    }
    if (this.session.joined()) this.media.stopAll();
    if (options.clearWorkspaceInvite) this.session.setWorkspaceInvite("");
    this.roomInput.set(room);
    this.selectedMode.set(mode);
    this.nameInput.set(name);
    sessionStorage.setItem("webrtc-display-name", name);
    history.replaceState(null, "", `/?room=${encodeURIComponent(room)}&mode=${mode}`);
    try {
      await this.session.join(room, name, mode);
      this.activeSection.set("live");
      void this.directory.load();
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "Beitritt fehlgeschlagen");
      this.activeSection.set("rooms");
    }
  }

  private async copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.notice.set("Einladungslink kopiert.");
    } catch {
      this.pageError.set("Einladungslink konnte nicht kopiert werden.");
    }
  }

  private clearMessages(): void {
    this.pageError.set("");
    this.notice.set("");
  }

  private shutdown(): void {
    this.media.stopAll();
    this.session.leave();
  }
}
