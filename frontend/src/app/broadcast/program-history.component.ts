import { ChangeDetectionStrategy, Component, OnDestroy, effect, signal } from "@angular/core";
import { NativeSourceProgramService } from "./native-source-program.service";
import { BroadcastControlPlaneService } from "./broadcast-control-plane.service";
import { ProgramHistoryController, type ProgramHistoryView } from "./program-history-controller";
import type { ProgramHistoryEvent } from "./program-history";
export const PROGRAM_HISTORY_TEMPLATE = `
  <section aria-labelledby="program-history-heading">
    <h3 id="program-history-heading">Bestätigter Programmverlauf</h3>
    <button type="button" class="button secondary" disabled [disabled]="!programs.historyContext() || view().phase === 'pending'"
      (click)="controller.query()">Verlauf aktuell laden</button>
    <p role="status" aria-live="polite">{{ status() }}</p>
    @if (view().value; as history) {
      <p>Programm-Epoche {{ history.programEpoch }} · Revision {{ history.programRevision }}.</p>
      <ol aria-label="Neueste Programmschritte zuerst">
        @for (event of history.events; track $index) {
          <li><time>{{ time(event.occurredAt) }}</time> · {{ eventText(event) }} · {{ stateText(event.state) }}
            <small>Epoche {{ event.programEpoch }}, Revision {{ event.programRevision }}</small></li>
        } @empty { <li>Keine gespeicherten Schritte in diesem begrenzten Zeitfenster.</li> }
      </ol>
    }
    <p>Maximal 32 letzte Schritte, höchstens 15 Minuten im Serverspeicher; kein vollständiges oder dauerhaftes Audit.
      Andere Programmaktivität kann ältere Einträge verdrängen. Die Momentaufnahme gilt höchstens fünf Sekunden.
      Keine Medien, Namen oder Untertiteltexte. Quellen-, Audio- und Szenenaktionen sind hier noch nicht enthalten.
      Eine bestätigte Ausgabe ist kein Nachweis, dass Zuschauer Bild oder Ton empfangen.</p>
  </section>`;
@Component({ selector: "app-program-history", standalone: true, changeDetection: ChangeDetectionStrategy.OnPush, template: PROGRAM_HISTORY_TEMPLATE })
export class ProgramHistoryComponent implements OnDestroy {
  readonly view = signal<ProgramHistoryView>({ phase: "idle", value: null });
  readonly controller: ProgramHistoryController;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(readonly programs: NativeSourceProgramService, api: BroadcastControlPlaneService) {
    this.controller = new ProgramHistoryController({ context: () => programs.historyContext(),
      query: (p, signal) => api.programHistory(p, signal), changed: v => this.view.set(v), now: () => performance.now() });
    this.timer = setInterval(() => this.controller.tick(), 250);
    effect(() => { programs.historyContext(); this.controller.tick(); });
  }
  status(): string { return { idle: "Noch nicht abgefragt.", pending: "Programmverlauf wird abgefragt…", ready: "Verlauf aktuell abgefragt.",
    stale: "Momentaufnahme veraltet oder Programm/Sitzung geändert. Bitte neu laden.",
    unavailable: "Verlauf nicht verfügbar. Berechtigung und Sitzung prüfen; bei zu vielen Abfragen eine Minute warten." }[this.view().phase]; }
  eventText(e: ProgramHistoryEvent): string {
    return { registered: "Programm registriert", "state-changed": "Programmzustand geändert",
      "standby-changed": `Standby-Vormerkung aktualisiert: ${e.standbyCount} Geräte (ohne Medienschlüssel)`,
      "handoff-begun": "Übergabe eingeleitet – bisherige Ausgabe gefencet",
      "handoff-assigned": "Nachfolger-Writer zugeordnet – noch keine Ausgabebestätigung",
      "handoff-stopped": "Übergabe beendet, Programm gestoppt" }[e.kind];
  }
  stateText(s: ProgramHistoryEvent["state"]): string { return { draft: "Entwurf", preparing: "Vorbereitung", awaiting_consent: "Zustimmung ausstehend",
    publishing: "Publikation läuft an", live: "Ausgabe bestätigt", degraded: "Ausgabe beeinträchtigt", stopping: "Wird gestoppt",
    stopped: "Gestoppt", failed: "Fehlgeschlagen" }[s]; }
  time(value: number): string { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString() : "Zeitpunkt nicht darstellbar"; }
  ngOnDestroy(): void { clearInterval(this.timer); this.controller.destroy(); }
}
