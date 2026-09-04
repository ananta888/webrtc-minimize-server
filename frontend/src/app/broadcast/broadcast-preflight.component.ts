import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, input, output, signal } from "@angular/core";

import { LiveCaptionService } from "../captions/live-caption.service";
import { VoskModelManagerService } from "../captions/vosk-model-manager.service";
import { MediaStreamDirective } from "../shared/media-stream.directive";
import { BroadcastAudienceComponent } from "./broadcast-audience.component";
import { BroadcastCaptionDestination, BroadcastCaptionSettingsService } from "./broadcast-caption-settings.service";
import { BroadcastModerationPanelComponent } from "./broadcast-moderation-panel.component";
import { BroadcastOwnSourcePreflightService } from "./broadcast-own-source-preflight.service";
import { BroadcastPublisherWorkflowService } from "./broadcast-publisher-workflow.service";
import { NativePackagerOnboardingService } from "./native-packager-onboarding.service";
import {
  TrustedDecryptConsentCandidate,
  TrustedDecryptConsentPanelComponent,
} from "./trusted-decrypt-consent-panel.component";
import { TrustedDecryptConsentView } from "./trusted-decrypt-key-lifecycle";
import { TrustedAudioProgramSettingsService } from "./trusted-audio-program-bus";
import { TrustedVideoProgramSettingsService } from "./trusted-video-compositor";

@Component({
  selector: "app-broadcast-preflight",
  standalone: true,
  imports: [MediaStreamDirective, TrustedDecryptConsentPanelComponent, BroadcastModerationPanelComponent, BroadcastAudienceComponent],
  templateUrl: "./broadcast-preflight.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BroadcastPreflightComponent implements OnInit, OnDestroy {
  readonly enabled = input(false);
  readonly browserPublisherEnabled = input(false);
  readonly nativePublisherEnabled = input(false);
  readonly joined = input(false);
  readonly authenticated = input(false);
  readonly roomId = input("");
  readonly roomCreator = input(false);
  readonly captionsActive = input(false);
  readonly trustedConsentCandidates = input<readonly TrustedDecryptConsentCandidate[]>([]);
  readonly trustedConsents = input<readonly TrustedDecryptConsentView[]>([]);
  readonly authorizeTrustedSource = output<TrustedDecryptConsentCandidate>();
  readonly revokeTrustedSource = output<string>();
  readonly loginRequested = output<void>();
  readonly deliveryProfile = signal<"origin-llhls">("origin-llhls");
  readonly packagerProfile = signal<"this-browser" | "native-agent">("this-browser");
  readonly programTitle = signal("Meine Live-Sendung");
  readonly controlError = this.publisher.errorCode;
  readonly controlBusy = this.publisher.busy;
  readonly activeProgramId = this.publisher.activeProgramId;
  readonly programState = computed(() => this.publisher.coordinator.programState.value());
  readonly eligibleNativePackagers = computed(() => this.nativePackagers.eligible(this.roomId()));
  readonly selectedNativePackager = computed(() => this.eligibleNativePackagers()
    .find(({ id }) => id === this.nativePackagers.selectedPackagerId()) || null);
  readonly packagerReady = computed(() => this.packagerProfile() === "this-browser"
    ? this.browserPublisherEnabled()
    : this.nativePublisherEnabled() && Boolean(this.selectedNativePackager()));
  readonly canStart = computed(() => this.enabled() && this.joined() && this.authenticated()
    && this.roomCreator() && this.preflight.lifecycle() === "ready"
    && this.preflight.selectedSourceIds().length > 0
    && this.packagerReady()
    && !this.controlBusy()
    && !new Set(["starting", "running", "degraded", "reconnecting", "handing_over", "stopping"])
      .has(this.programState().lifecycle));
  readonly canStop = computed(() => Boolean(this.activeProgramId() || this.programState().program?.programId)
    && this.programState().lifecycle !== "stopping");
  readonly estimatedCpuClass = computed(() => {
    const profile = this.videoSettings.profile();
    const pixelsPerSecond = profile.width * profile.height * profile.framesPerSecond;
    return pixelsPerSecond > 45_000_000 ? "hoch" : pixelsPerSecond > 15_000_000 ? "mittel" : "niedrig";
  });
  constructor(
    readonly preflight: BroadcastOwnSourcePreflightService,
    readonly audioSettings: TrustedAudioProgramSettingsService,
    readonly videoSettings: TrustedVideoProgramSettingsService,
    readonly captionSettings: BroadcastCaptionSettingsService,
    readonly captionModels: VoskModelManagerService,
    private readonly captions: LiveCaptionService,
    readonly publisher: BroadcastPublisherWorkflowService,
    readonly nativePackagers: NativePackagerOnboardingService,
  ) {}

  ngOnInit(): void {
    this.preflight.setPanelVisible(true);
    this.captionSettings.setDestination("localOverlay", this.captions.showOverlay());
    this.captionSettings.setDestination("shareWithRoom", this.captions.shareWithRoom());
  }

  ngOnDestroy(): void {
    this.preflight.setPanelVisible(false);
    void this.preflight.stopPreview("panel-close");
  }

  setSourceSelected(sourceId: string, selected: boolean): void {
    this.preflight.setSourceSelected(sourceId, selected);
  }

  setProgramTitle(value: unknown): void {
    if (typeof value === "string") this.programTitle.set(value.slice(0, 80));
  }

  async setAudience(value: unknown): Promise<void> {
    const previous = this.preflight.audience();
    if (!this.preflight.setAudience(value)) return;
    const programId = this.programState().program?.programId;
    if (!programId || previous === value) return;
    if (!window.confirm(
      "Die Sichtbarkeit wird sofort geändert. Laufende Zuschauer-Grants werden widerrufen; "
      + "dadurch kann eine kurze Unterbrechung entstehen. Fortfahren?",
    )) {
      this.preflight.setAudience(previous);
      return;
    }
    try {
      await this.publisher.setVisibility(this.preflight.audience());
    } catch (error) {
      this.preflight.setAudience(previous);
    }
  }

  async startBroadcast(): Promise<void> {
    if (!this.canStart()) return;
    if (!window.confirm(
      "Jetzt werden ausschließlich die gewählten eigenen Quellen an den Trusted Broadcast-Gateway gesendet. "
      + "Dieser Broadcast-Zweig ist nicht SFrame-E2EE. Wirklich starten?",
    )) return;
    const roomId = this.roomId();
    const title = this.programTitle().trim();
    if (!title) {
      this.publisher.errorCode.set("broadcast_title_required");
      return;
    }
    try {
      await this.publisher.start({
        requestVersion: 1,
        trigger: "user-action",
        roomId,
        title,
        visibility: this.preflight.audience(),
        sourceIds: Object.freeze([...this.preflight.selectedSourceIds()]),
        adapterId: this.packagerProfile() === "native-agent" ? "native-bridge" : "whip-browser",
        ...(this.packagerProfile() === "native-agent" && this.selectedNativePackager() ? {
          packagerId: this.selectedNativePackager()!.id,
          requestedRenditions: Math.min(3, this.selectedNativePackager()!.capability?.maximumRenditions || 1),
        } : {}),
      });
    } catch { /* The workflow publishes a bounded visible error code. */ }
  }

  setPackagerProfile(value: unknown): void {
    if (value === "this-browser") {
      this.packagerProfile.set(value);
      return;
    }
    if (typeof value !== "string" || !value.startsWith("native:")) return;
    const packagerId = value.slice(7);
    if (!this.eligibleNativePackagers().some(({ id }) => id === packagerId)
      || !this.nativePackagers.select(packagerId)) return;
    this.packagerProfile.set("native-agent");
  }

  async stopBroadcast(): Promise<void> {
    try { await this.publisher.stop("user-stop"); } catch { /* The workflow exposes the failed step. */ }
  }

  async preparePreview(): Promise<void> {
    try {
      await this.preflight.preparePreview("user-action");
    } catch {
      // The service exposes its bounded errorCode for the visible panel.
    }
  }

  async stopPreview(): Promise<void> {
    try {
      await this.preflight.stopPreview();
    } catch {
      // A retained cleanup handle can be retried with the same visible action.
    }
  }

  async setAudioProfile(value: unknown): Promise<void> {
    if (!this.audioSettings.setProfile(value)) return;
    await this.refreshReadyAudioPreview();
  }

  async setAudioMonitoring(value: unknown): Promise<void> {
    if (!this.audioSettings.setMonitoring(value, "user-action")) return;
    await this.refreshReadyAudioPreview();
  }

  async setVideoProfile(value: unknown): Promise<void> {
    if (!this.videoSettings.setProfile(value)) return;
    await this.refreshReadyPreview("video");
  }

  async setVideoLayout(value: unknown): Promise<void> {
    if (!this.videoSettings.setLayout(value)) return;
    await this.refreshReadyPreview("video");
  }

  setCaptionDestination(destination: BroadcastCaptionDestination, enabled: unknown): void {
    const requested = enabled === true;
    if (destination === "localOverlay") this.captions.setOverlay(requested);
    if (destination === "shareWithRoom" && !this.captions.setShareWithRoom(requested)) return;
    if (!this.captionSettings.setDestination(destination, requested)) return;
    if (destination === "broadcastTextTrack" || destination === "broadcastBurnIn") {
      const consent = this.captionSettings.consent();
      this.preflight.setIncludeCaptions(consent.broadcastTextTrack || consent.broadcastBurnIn);
    }
  }

  setCaptionModel(value: unknown): void {
    if (!this.captionModels.select(value)) return;
    const model = this.captionModels.selectedModel();
    this.captionSettings.patchSettings({ modelId: model.id, language: model.languageTag });
  }

  async loadCaptionModel(): Promise<void> {
    await this.captionModels.loadSelected();
  }

  setCaptionSpeakerMode(value: unknown): void {
    if (value !== "off" && value !== "custom") return;
    const fallbackLabel = value === "custom" && !this.captionSettings.settings().speakerLabel ? "Sprecher" : this.captionSettings.settings().speakerLabel;
    this.captionSettings.patchSettings({ speakerMode: value, speakerLabel: fallbackLabel });
  }

  setCaptionSpeakerLabel(value: unknown): void {
    if (typeof value === "string") this.captionSettings.patchSettings({ speakerLabel: value });
  }

  setCaptionDelay(value: unknown): void {
    this.captionSettings.patchSettings({ delayMs: Number(value) });
  }

  setCaptionLineLength(value: unknown): void {
    this.captionSettings.patchSettings({ maximumLineLength: Number(value) });
  }

  setCaptionPosition(value: unknown): void {
    this.captionSettings.patchSettings({ positionPercent: Number(value) });
  }

  setCaptionStyle(value: unknown): void {
    if (value === "high-contrast" || value === "subtle" || value === "large") {
      this.captionSettings.patchSettings({ style: value });
    }
  }

  private async refreshReadyAudioPreview(): Promise<void> {
    await this.refreshReadyPreview("audio");
  }

  private async refreshReadyPreview(kind: "audio" | "video"): Promise<void> {
    if (this.preflight.lifecycle() !== "ready"
      || !this.preflight.selectedSources().some((source) => source.kind === kind)) return;
    try {
      await this.preflight.stopPreview("audio-policy-changed");
      await this.preflight.preparePreview("user-action");
    } catch {
      // The service exposes the bounded lifecycle error for the visible panel.
    }
  }

}
