import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, input, output } from "@angular/core";

import { MediaStreamDirective } from "../shared/media-stream.directive";
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
  imports: [MediaStreamDirective, TrustedDecryptConsentPanelComponent],
  templateUrl: "./broadcast-preflight.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BroadcastPreflightComponent implements OnInit, OnDestroy {
  readonly joined = input(false);
  readonly captionsActive = input(false);
  readonly trustedConsentCandidates = input<readonly TrustedDecryptConsentCandidate[]>([]);
  readonly trustedConsents = input<readonly TrustedDecryptConsentView[]>([]);
  readonly authorizeTrustedSource = output<TrustedDecryptConsentCandidate>();
  readonly revokeTrustedSource = output<string>();

  constructor(
    readonly preflight: BroadcastOwnSourcePreflightService,
    readonly audioSettings: TrustedAudioProgramSettingsService,
    readonly videoSettings: TrustedVideoProgramSettingsService,
  ) {}

  ngOnInit(): void {
    this.preflight.setPanelVisible(true);
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
