import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, effect, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";

import { OidcAuthService } from "../../auth/oidc-auth.service";
import { BroadcastOwnSourcePreflightService } from "../../broadcast/broadcast-own-source-preflight.service";
import {
  NativePackagerOnboardingService,
  NativePackagerPlatform,
} from "../../broadcast/native-packager-onboarding.service";
import { BroadcastPreflightComponent } from "../../broadcast/broadcast-preflight.component";
import {
  BrowserWhipBroadcastRuntimeService,
  ExplicitBroadcastConsentService,
} from "../../broadcast/broadcast-browser-runtime.service";
import { BroadcastCoordinatorService } from "../../broadcast/broadcast-coordinator.service";
import { BroadcastDeliveryCapabilityService } from "../../broadcast/broadcast-delivery-capability.service";
import { BroadcastOwnSourceCaptureService } from "../../broadcast/broadcast-own-source-capture.service";
import { BroadcastOwnSourceCompositionService } from "../../broadcast/broadcast-own-source-composition.service";
import {
  BROADCAST_CAPTURE_FORK_PORT,
  BROADCAST_COMPOSITION_PORT,
  BROADCAST_CONSENT_PORT,
  BROADCAST_PUBLICATION_ADAPTERS,
  BROADCAST_STATS_PORT,
} from "../../broadcast/broadcast-ports";
import { BroadcastProgramStateService } from "../../broadcast/broadcast-program-state.service";
import { BroadcastPublisherWorkflowService } from "../../broadcast/broadcast-publisher-workflow.service";
import { BroadcastSourceSelectionService } from "../../broadcast/broadcast-source-selection.service";
import { LiveCaptionService } from "../../captions/live-caption.service";
import { formatModelSize } from "../../captions/vosk-model-catalog";
import { VoskModelManagerService } from "../../captions/vosk-model-manager.service";
import { RuntimeConfigService } from "../../core/runtime-config.service";
import { DeviceIdentityService } from "../../identity/device-identity.service";
import {
  MediaAgentOnboardingService,
  MediaAgentPlatform,
} from "../../media-agent/media-agent-onboarding.service";
import {
  RoomDirectoryService,
  RoomSummary,
  RoomVisibility,
} from "../../rooms/room-directory.service";
import { MediaControlBarComponent } from "../../shared/media-control-bar.component";
import { MediaStreamDirective } from "../../shared/media-stream.directive";
import { MediaMosaicComponent } from "../../shared/media-mosaic.component";
import { BlindMediaAgentService } from "../../webrtc/blind-media-agent.service";
import { CaptionAudioSource } from "../../webrtc/caption-contract";
import { OptimizationMode } from "../../webrtc/media-optimization-policy";
import { MediaPublicationService } from "../../webrtc/media-publication.service";
import { MediaStrategyService } from "../../webrtc/media-strategy.service";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { ReceiveQualityPreferenceService } from "../../webrtc/receive-quality-preference.service";
import { RoomMode, RoomSessionService } from "../../webrtc/room-session.service";
import { SignalingService } from "../../webrtc/signaling.service";
import { VideoCapturePreferencesService, VideoCaptureSource } from "../../webrtc/video-capture-preferences.service";
import { PairWorkspacePanelComponent } from "../../workspace/pair-workspace-panel.component";
import { PairWorkspaceService, WorkspaceSummary } from "../../workspace/pair-workspace.service";
import { MeshAnalysisComponent } from "../../mesh-analysis/mesh-analysis.component";

type AppSection = "rooms" | "live" | "broadcast" | "captions" | "analysis" | "chat" | "settings";

@Component({
  selector: "app-room-page",
  standalone: true,
  imports: [
    FormsModule,
    BroadcastPreflightComponent,
    MediaControlBarComponent,
    MediaStreamDirective,
    MediaMosaicComponent,
    MeshAnalysisComponent,
    PairWorkspacePanelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./room-page.component.html",
  providers: [
    BroadcastCoordinatorService,
    BroadcastDeliveryCapabilityService,
    BroadcastProgramStateService,
    BroadcastPublisherWorkflowService,
    BroadcastSourceSelectionService,
    { provide: BROADCAST_CONSENT_PORT, useExisting: ExplicitBroadcastConsentService },
    { provide: BROADCAST_CAPTURE_FORK_PORT, useExisting: BroadcastOwnSourceCaptureService },
    { provide: BROADCAST_COMPOSITION_PORT, useExisting: BroadcastOwnSourceCompositionService },
    {
      provide: BROADCAST_PUBLICATION_ADAPTERS,
      useFactory: (adapter: BrowserWhipBroadcastRuntimeService) => Object.freeze([adapter]),
      deps: [BrowserWhipBroadcastRuntimeService],
    },
    { provide: BROADCAST_STATS_PORT, useExisting: BrowserWhipBroadcastRuntimeService },
  ],
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
  readonly captionModelSearch = signal("");
  readonly workspaceTitle = signal("Pair Dev Workspace");
  readonly mediaAgentLabel = signal("Mein Rechner");
  readonly mediaAgentTarget = signal("");
  readonly nativePackagerLabel = signal("Mein Broadcast-Rechner");
  readonly nativePackagerTarget = signal("");
  readonly connectionLabel = computed(() => {
    if (this.session.joined()) return "Signaling verbunden";
    if (this.signaling.status() === "connecting") return "Verbindung wird aufgebaut";
    if (this.signaling.status() === "error") return "Verbindung fehlgeschlagen";
    return "Nicht verbunden";
  });
  readonly authRequired = computed(() => this.config.value()?.auth.mode === "required");
  readonly canEnter = computed(() => this.ready() && (!this.authRequired() || this.auth.authenticated()));
  readonly canOwnRooms = computed(() => this.auth.authenticated());
  readonly ownMediaAgentOnline = computed(() => (
    this.mediaAgentOnboarding.agents().some((agent) => agent.online)
    || this.mediaAgentOnboarding.operatorAgents().some((agent) => agent.online)
  ));
  readonly broadcastActive = computed(() => this.broadcastPreflight.lifecycle() === "ready"
    || new Set(["starting", "running", "degraded", "reconnecting", "handing_over", "stopping"])
      .has(this.broadcastPublisher.coordinator.programState.value().lifecycle));
  readonly filteredCaptionModels = computed(() => {
    const query = this.captionModelSearch().trim().toLocaleLowerCase("de-DE");
    if (!query) return this.captionModels.models;
    return this.captionModels.models.filter((model) => (
      `${model.language} ${model.nativeLanguage} ${model.languageTag} ${model.id}`.toLocaleLowerCase("de-DE").includes(query)
    ));
  });
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
    || this.broadcastPreflight.errorCode()
    || this.captions.error()
    || this.captionModels.error()
    || this.mediaAgentOnboarding.error()
    || this.nativePackagerOnboarding.error()
    || this.auth.error()
  ));
  private directoryRefreshHandle: ReturnType<typeof setInterval> | null = null;
  private readonly beforeUnload = () => this.shutdown();
  private readonly pageHide = () => this.shutdown();
  private readonly stopCaptureOnSessionEnd = effect(() => {
    if (!this.session.joined() && this.signaling.status() !== "connecting") {
      void this.resetBroadcastPreflight();
      this.media.stopAll();
    }
  });

  constructor(
    readonly config: RuntimeConfigService,
    readonly auth: OidcAuthService,
    readonly device: DeviceIdentityService,
    readonly mediaAgentOnboarding: MediaAgentOnboardingService,
    readonly nativePackagerOnboarding: NativePackagerOnboardingService,
    readonly signaling: SignalingService,
    readonly session: RoomSessionService,
    readonly mesh: PeerMeshService,
    readonly mediaAgents: BlindMediaAgentService,
    readonly media: MediaPublicationService,
    readonly broadcastPreflight: BroadcastOwnSourcePreflightService,
    readonly broadcastPublisher: BroadcastPublisherWorkflowService,
    readonly captions: LiveCaptionService,
    readonly captionModels: VoskModelManagerService,
    readonly mediaStrategy: MediaStrategyService,
    readonly receiveQuality: ReceiveQualityPreferenceService,
    readonly videoPreferences: VideoCapturePreferencesService,
    readonly directory: RoomDirectoryService,
    readonly workspaces: PairWorkspaceService,
  ) {}

  async ngOnInit(): Promise<void> {
    window.addEventListener("beforeunload", this.beforeUnload);
    window.addEventListener("pagehide", this.pageHide);
    const params = new URLSearchParams(location.search);
    if (new Set<AppSection>(["rooms", "live", "broadcast", "captions", "analysis", "chat", "settings"]).has(params.get("section") as AppSection)) {
      this.activeSection.set(params.get("section") as AppSection);
    }
    this.roomInput.set(params.get("room") || "");
    this.selectedMode.set(params.get("mode") === "pair" ? "pair" : "room");
    this.session.setWorkspaceInvite(params.get("workspaceInvite") || "");
    try {
      const runtime = await this.config.load();
      this.auth.configure(runtime);
      if (!this.nameInput().trim() && this.auth.username()) this.nameInput.set(this.auth.username());
      if (runtime.mediaAgents.selfService) {
        this.mediaAgentTarget.set(this.mediaAgentOnboarding.suggestedTarget(runtime.mediaAgents.targets));
      }
      if (runtime.nativePackagers.selfService) {
        this.nativePackagerTarget.set(this.nativePackagerOnboarding.suggestedTarget(runtime.nativePackagers.targets));
      }
      this.ready.set(true);
      await Promise.all([
        this.directory.load(),
        this.auth.authenticated() && (runtime.mediaAgents.selfService || runtime.mediaAgents.configured)
          ? this.mediaAgentOnboarding.load()
          : Promise.resolve(),
        this.auth.authenticated() && runtime.nativePackagers.selfService
          ? this.nativePackagerOnboarding.load()
          : Promise.resolve(),
        this.auth.authenticated() && this.config.value()?.pairWorkspaceEnabled
          ? this.workspaces.loadList()
          : Promise.resolve(),
      ]);
      this.directoryRefreshHandle = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        void this.directory.load();
        if (this.auth.authenticated()
          && (this.config.value()?.mediaAgents.selfService || this.config.value()?.mediaAgents.configured)) {
          void this.mediaAgentOnboarding.load();
        }
        if (this.auth.authenticated() && this.config.value()?.nativePackagers.selfService) {
          void this.nativePackagerOnboarding.load();
        }
      }, 15_000);
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "Konfiguration konnte nicht geladen werden");
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener("beforeunload", this.beforeUnload);
    window.removeEventListener("pagehide", this.pageHide);
    if (this.directoryRefreshHandle) clearInterval(this.directoryRefreshHandle);
    this.stopCaptureOnSessionEnd.destroy();
    this.shutdown();
    void this.broadcastPreflight.destroy().catch(() => undefined);
    this.captions.destroy();
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

  async leave(): Promise<void> {
    await this.resetBroadcastPreflight();
    this.captions.stop();
    this.media.stopAll();
    this.session.leave();
    this.notice.set("Du hast den Raum verlassen.");
    this.activeSection.set("rooms");
    void this.directory.load();
  }

  async logout(): Promise<void> {
    await this.resetBroadcastPreflight();
    this.captions.stop();
    this.media.stopAll();
    this.session.leave();
    this.activeSection.set("rooms");
    this.directory.clearOwnRooms();
    this.mediaAgentOnboarding.clear();
    this.nativePackagerOnboarding.clear();
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

  setCaptionModel(modelId: unknown): void {
    if (!this.captions.active()) this.captionModels.select(modelId);
  }

  setCaptionSource(source: unknown): void {
    this.captions.selectSource(source);
  }

  setCaptionSharing(enabled: unknown): void {
    this.captions.setShareWithRoom(enabled);
  }

  async loadCaptionModel(): Promise<void> {
    this.clearMessages();
    await this.captionModels.loadSelected();
  }

  cancelCaptionModelLoad(): void {
    this.captionModels.cancelLoad();
  }

  async removeCachedCaptionModel(modelId: string): Promise<void> {
    await this.captionModels.removeCachedModel(modelId);
  }

  async toggleCaptions(): Promise<void> {
    const source = this.captions.selectedSource();
    if (this.captions.isSourceActive(source)) {
      this.captions.stop(source);
      return;
    }
    await this.captions.start(source);
  }

  stopAllCaptions(): void {
    this.captions.stop();
  }

  setCaptionOverlay(enabled: unknown): void {
    this.captions.setOverlay(enabled);
  }

  captionModelSize(sizeBytes: number): string {
    return formatModelSize(sizeBytes);
  }

  captionModelStatusLabel(): string {
    if (this.captions.active()) {
      const count = this.captions.activeSources().length;
      return count === 1 ? "Eine Quelle aktiv" : `${count} Quellen aktiv`;
    }
    if (this.captions.starting()) return "Erkennung startet";
    return {
      idle: "Nicht geladen",
      downloading: "Download läuft",
      preparing: "Worker startet",
      ready: "Modell bereit",
      error: "Fehler",
    }[this.captionModels.status()];
  }

  captionTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  captionSourceLabel(source: CaptionAudioSource): string {
    return source === "microphone" ? "Mikrofon" : "Bildschirmton";
  }

  captionSourceStatus(source: CaptionAudioSource): string {
    if (this.captions.isSourceActive(source)) return "Transkription aktiv";
    if (this.captions.isSourceStarting(source)) return "wird gestartet";
    if (this.captions.sourceAvailable(source)) return "Audiotrack bereit";
    if (source === "microphone") return "Mikrofon nicht aktiv";
    if (this.media.active("screen") && this.videoPreferences.screenAudioEnabled()) {
      return "kein Audiotrack vom Browser";
    }
    return "Bildschirmton nicht freigegeben";
  }

  captionActiveSourcesLabel(): string {
    const sources = this.captions.activeSources();
    return sources.length > 0
      ? sources.map((source) => this.captionSourceLabel(source)).join(" + ")
      : this.captionSourceLabel(this.captions.selectedSource());
  }

  setOptimizationMode(mode: OptimizationMode): void {
    this.media.setOptimizationMode(mode);
  }

  setMediaStrategyPreset(preset: unknown): void {
    void this.media.setMediaStrategyPreset(preset);
  }

  setAudioQualityProfile(profile: unknown): void {
    void this.media.setAudioQualityProfile(profile);
  }

  setMediaPriorityAt(index: number, source: unknown): void {
    this.media.setMediaPriorityAt(index, source);
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

  setMediaAgentSelected(agentId: string, enabled: boolean): void {
    this.mediaAgents.setAgentSelected(agentId, enabled);
  }

  setMediaAgentConsent(enabled: boolean): void {
    try {
      this.mediaAgents.setConsent(enabled);
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "media_agent_consent_failed");
    }
  }

  setMediaAgentAutomaticTakeover(enabled: boolean): void {
    try {
      this.mediaAgents.setAutomaticTakeover(enabled);
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "media_agent_takeover_update_failed");
    }
  }

  setReceiveQualityProfile(value: unknown): void {
    this.mesh.setReceiveQualityProfile(value);
  }

  async downloadMediaAgentInstaller(): Promise<void> {
    this.clearMessages();
    const target = this.mediaAgentTarget();
    const label = this.mediaAgentLabel().trim();
    if (!target || !label) {
      this.pageError.set("Bitte wähle ein System und gib dem Rechner einen Namen.");
      return;
    }
    try {
      const pending = await this.mediaAgentOnboarding.downloadInstaller(target, label);
      this.notice.set(`Installationsdatei ${pending.filename} wurde erstellt. Führe sie innerhalb von zehn Minuten bewusst aus.`);
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "Installationsdatei konnte nicht erstellt werden");
    }
  }

  async revokeMediaAgent(agentId: string): Promise<void> {
    if (!window.confirm("Diesen Media-Agent wirklich widerrufen? Laufende Agent-Verbindungen werden sofort beendet.")) return;
    this.clearMessages();
    try {
      await this.mediaAgentOnboarding.revoke(agentId);
      this.notice.set("Media-Agent wurde widerrufen. Die lokale Anwendung kann jetzt entfernt werden.");
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "Media-Agent konnte nicht widerrufen werden");
    }
  }

  async downloadNativePackagerInstaller(): Promise<void> {
    this.clearMessages();
    const target = this.nativePackagerTarget();
    const label = this.nativePackagerLabel().trim();
    if (!target || !label) { this.pageError.set("Bitte wähle ein System und gib dem Packager einen Namen."); return; }
    try {
      await this.nativePackagerOnboarding.downloadInstaller(target, label);
      this.notice.set("Native-Packager-Installer erstellt. Führe ihn innerhalb von zehn Minuten bewusst aus.");
    } catch (error) { this.pageError.set(error instanceof Error ? error.message : "Packager-Installer konnte nicht erstellt werden"); }
  }

  async setNativePackagerRoomConsent(packagerId: string, enabled: boolean): Promise<void> {
    if (!this.session.joined()) { this.pageError.set("Betritt zuerst den Raum."); return; }
    try {
      await this.nativePackagerOnboarding.setRoomConsent(packagerId, this.session.roomId(), enabled);
      this.notice.set(enabled ? "Native-Packager für diesen Raum freigegeben." : "Native-Packager-Freigabe widerrufen.");
    } catch (error) { this.pageError.set(error instanceof Error ? error.message : "Raumfreigabe fehlgeschlagen"); }
  }

  async revokeNativePackager(packagerId: string): Promise<void> {
    if (!window.confirm("Diesen Trusted-Packager widerrufen? Seine Control-Verbindung wird sofort beendet.")) return;
    try { await this.nativePackagerOnboarding.revoke(packagerId); this.notice.set("Native-Packager widerrufen."); }
    catch (error) { this.pageError.set(error instanceof Error ? error.message : "Native-Packager konnte nicht widerrufen werden"); }
  }

  nativePackagerPlatformLabel(platform: NativePackagerPlatform): string {
    return ({ linux: "Linux", macos: "macOS", windows: "Windows" })[platform];
  }

  mediaAgentPlatformLabel(platform: MediaAgentPlatform): string {
    return ({ linux: "Linux", macos: "macOS", windows: "Windows" })[platform];
  }

  mediaAgentLastSeen(timestamp: number): string {
    return timestamp ? new Date(timestamp).toLocaleString("de-DE") : "noch nie angemeldet";
  }

  respondToMediaAgentTakeover(accepted: boolean): void {
    try {
      this.mediaAgents.respondToTakeover(accepted);
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "media_agent_takeover_response_failed");
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
    if (this.session.joined()) {
      await this.resetBroadcastPreflight();
      this.media.stopAll();
    }
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
    void this.resetBroadcastPreflight();
    this.captions.stop();
    this.media.stopAll();
    this.session.leave();
  }

  private async resetBroadcastPreflight(): Promise<void> {
    try {
      await this.broadcastPublisher.resetForSession();
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : "broadcast_preview_cleanup_failed");
    }
  }
}
