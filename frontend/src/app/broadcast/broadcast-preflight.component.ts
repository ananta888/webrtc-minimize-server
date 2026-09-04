import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, input, output, signal } from "@angular/core";

import { LiveCaptionService } from "../captions/live-caption.service";
import { VoskModelManagerService } from "../captions/vosk-model-manager.service";
import { MediaStreamDirective } from "../shared/media-stream.directive";
import { BroadcastAudienceComponent } from "./broadcast-audience.component";
import { BroadcastCaptionDestination, BroadcastCaptionSettingsService } from "./broadcast-caption-settings.service";
import { BroadcastModerationPanelComponent } from "./broadcast-moderation-panel.component";
import { BroadcastOwnSourcePreflightService } from "./broadcast-own-source-preflight.service";
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
  readonly joined = input(false);
  readonly authenticated = input(false);
  readonly captionsActive = input(false);
  readonly trustedConsentCandidates = input<readonly TrustedDecryptConsentCandidate[]>([]);
  readonly trustedConsents = input<readonly TrustedDecryptConsentView[]>([]);
  readonly authorizeTrustedSource = output<TrustedDecryptConsentCandidate>();
  readonly revokeTrustedSource = output<string>();
  readonly loginRequested = output<void>();
  readonly deliveryProfile = signal<"origin-llhls">("origin-llhls");
  readonly packagerProfile = signal<"this-browser">("this-browser");
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
