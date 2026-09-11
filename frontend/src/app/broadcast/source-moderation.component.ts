import { ChangeDetectionStrategy, Component } from "@angular/core";
import { SourceModerationService } from "./source-moderation.service";
import { ModeratedSource } from "./source-moderation-contract";

export const SOURCE_MODERATION_TEMPLATE = `
    <section aria-labelledby="source-moderation-title">
      <h3 id="source-moderation-title">Aktive Broadcast-Quellenfreigaben</h3>
      <p>Als Programm-Ersteller kannst du einzelne Quellen aus dieser Sendung entfernen.
        Das widerruft die Freigabe für den Trusted Packager, nicht die Kamera oder den Ton im Raum.
        Erneute Nutzung benötigt eine neue Anfrage und Zustimmung des Teilnehmers.</p>
      <button id="source-moderation-query" type="button" class="button secondary" disabled
        [disabled]="!moderation.programs.sceneContext() || busy()" (click)="moderation.controller.query()">Freigaben aktuell abfragen</button>
      <p role="status" aria-live="polite">{{ status() }}</p>
      @if (moderation.view().state; as state) {
        <p>Momentaufnahme, höchstens fünf Sekunden gültig. Eine Freigabe bestätigt noch keinen Bild- oder Tonempfang.</p>
        @for (source of state.sources; track source.consentId) {
          <article>
            <p>{{ label(source) }} · {{ moderation.programs.publisherName(source.publisherPeerId) || source.publisherPeerId }}</p>
            <small>Quelle: {{ source.sourceId }}</small>
            <button type="button" class="button danger" disabled [disabled]="busy()"
              (click)="remove(source)">{{ label(source) }} aus Sendung entfernen…</button>
          </article>
        } @empty { <p>Keine aktuell gültigen Quellenfreigaben vorhanden.</p> }
      }
    </section>`;
@Component({
  selector: "app-source-moderation", standalone: true, providers: [SourceModerationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: SOURCE_MODERATION_TEMPLATE,
})
export class SourceModerationComponent {
  constructor(readonly moderation: SourceModerationService) {}
  busy(): boolean { return ["pending", "revoking"].includes(this.moderation.view().phase); }
  status(): string {
    return { idle: "Noch nicht abgefragt.", pending: "Freigaben werden geprüft…", ready: "Freigaben aktuell geprüft.",
      revoking: "Widerruf wird angefordert…", revoked: "Freigabe serverseitig widerrufen. Liste bei Bedarf neu abfragen.",
      unavailable: "Keine aktuelle Bestätigung. Bitte neu abfragen; ein gesendeter Widerruf kann bereits wirksam sein.",
      stale: "Momentaufnahme abgelaufen oder Sendung geändert. Bitte neu abfragen." }[this.moderation.view().phase];
  }
  label(source: ModeratedSource): string {
    return { camera: "Kamera", microphone: "Mikrofon", screen: "Bildschirm", "screen-audio": "Bildschirmton" }[source.sourceKind];
  }
  remove(source: ModeratedSource): void {
    const snapshot = this.moderation.view().state;
    if (!this.moderation.controller.canRevoke(source.consentId, snapshot)) return;
    if (!window.confirm(`${this.label(source)} aus dieser Sendung entfernen? Der Trusted Packager verliert diese Freigabe. `
      + "Andere Quellen und die Freigabe im Raum bleiben unverändert. Für eine erneute Nutzung ist eine neue Zustimmung nötig.")) return;
    this.moderation.controller.revoke(source.consentId, snapshot);
  }
}
