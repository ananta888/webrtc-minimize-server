import { DatePipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";

import { TrustedDecryptConsentView, TrustedDecryptSourceKind } from "./trusted-decrypt-key-lifecycle";

export interface TrustedDecryptConsentCandidate {
  readonly candidateVersion: 1;
  readonly requestId: string;
  readonly programId: string;
  readonly programTitle: string;
  readonly packagerRef: string;
  readonly packagerLabel: string;
  readonly deviceRef: string;
  readonly deviceLabel: string;
  readonly sourceId: string;
  readonly sourceKind: TrustedDecryptSourceKind;
  readonly sourceLabel: string;
  readonly expiresAt: number;
}

@Component({
  selector: "app-trusted-decrypt-consent-panel",
  standalone: true,
  imports: [DatePipe],
  templateUrl: "./trusted-decrypt-consent-panel.component.html",
  styleUrl: "./trusted-decrypt-consent-panel.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrustedDecryptConsentPanelComponent {
  readonly candidates = input<readonly TrustedDecryptConsentCandidate[]>([]);
  readonly consents = input<readonly TrustedDecryptConsentView[]>([]);
  readonly authorizeRequest = output<TrustedDecryptConsentCandidate>();
  readonly revokeRequest = output<string>();

  approve(candidate: TrustedDecryptConsentCandidate): void {
    this.authorizeRequest.emit(candidate);
  }

  revoke(consentId: string): void {
    this.revokeRequest.emit(consentId);
  }

  sourceKindLabel(kind: TrustedDecryptSourceKind): string {
    return ({ microphone: "Mikrofon", camera: "Kamera", screen: "Bildschirm", "screen-audio": "Bildschirmton" })[kind];
  }
}
