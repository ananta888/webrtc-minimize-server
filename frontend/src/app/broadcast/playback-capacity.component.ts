import { ChangeDetectionStrategy, Component, OnDestroy, effect, signal } from "@angular/core";
import { NativeSourceProgramService } from "./native-source-program.service";
import { BroadcastControlPlaneService } from "./broadcast-control-plane.service";
import { PlaybackCapacityController, type PlaybackCapacityState } from "./playback-capacity-controller";

export const PLAYBACK_CAPACITY_TEMPLATE = `
  <section aria-labelledby="playback-capacity-heading">
    <h3 id="playback-capacity-heading">Wiedergabesitzungen der Sendung</h3>
    <label>Zusätzliche Sitzungen prüfen
      <input id="playback-capacity-additional" type="number" min="1" max="10000" step="1"
        [value]="additional()" (input)="additional.set($any($event.target).value)" />
    </label>
    <button type="button" class="button secondary" [disabled]="!context() || state().phase === 'pending'"
      (click)="query()">Wiedergabekapazität prüfen</button>
    <p role="status" aria-live="polite">{{ statusText() }}</p>
    @if (state().value; as v) {
      <p>{{ v.programSessions }} belegte Cookie-Sitzungen dieser Sendung · Programmlimit {{ v.programLimit }}.</p>
      <p>Limit je Publikumsidentität: {{ v.perAudienceLimit }} Sitzungen, auch über andere Sendungen hinweg.</p>
      <p>{{ v.additionalSessions }} zusätzliche Sitzungen: {{ v.sharedBudgetsFit ? 'passen zum Prüfzeitpunkt in die gemeinsamen Sitzungsbudgets.' : 'passen momentan nicht in die gemeinsamen Sitzungsbudgets.' }}</p>
      @if (v.perAudienceLimit === 0) { <p>Neue Wiedergabesitzungen sind durch das Publikumslimit gesperrt.</p> }
    }
    <p>Cookie-Sitzungen sind keine Zahl aktiver Menschen. Geschlossene Tabs können bis zum Ablauf weiter zählen.
      Höchstens fünf Sekunden aktuell, keine Reservierung und keine Bandbreiten- oder CDN-Zusage.
      Jede Wiedergabe prüft Berechtigung, Identitätslimit und aktuelle Kapazität erneut.</p>
  </section>`;
@Component({ selector: "app-playback-capacity", standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush, template: PLAYBACK_CAPACITY_TEMPLATE })
export class PlaybackCapacityComponent implements OnDestroy {
  readonly additional = signal("1");
  readonly state = signal<PlaybackCapacityState>({ phase: "idle", value: null });
  private readonly controller: PlaybackCapacityController;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly programs: NativeSourceProgramService, api: BroadcastControlPlaneService) {
    this.controller = new PlaybackCapacityController({ context: () => this.context(),
      query: (p, n, signal) => api.playbackCapacity(p, n, signal), changed: s => this.state.set(s), now: () => performance.now() });
    this.timer = setInterval(() => this.controller.tick(), 250);
    effect(() => { this.context(); this.controller.tick(); });
  }
  context() {
    const c = this.programs.sceneContext(), raw = this.additional(), additionalSessions = Number(raw);
    return c && /^\d{1,5}$/.test(raw) && additionalSessions >= 1 && additionalSessions <= 10000
      ? { ...c, additionalSessions } : null;
  }
  query(): Promise<void> { return this.controller.query(); }
  statusText(): string {
    switch (this.state().phase) {
      case "pending": return "Wiedergabesitzungen werden geprüft…";
      case "current": return "Aktuelle Momentaufnahme, keine Reservierung.";
      case "stale": return "Abfrage veraltet oder Auswahl/Sitzung geändert. Bitte erneut prüfen.";
      case "unavailable": return "Keine Kapazitätsauskunft verfügbar. Berechtigung und laufende Sendung prüfen; bei zu vielen Anfragen eine Minute warten.";
      default: return "Noch keine Abfrage durchgeführt.";
    }
  }
  ngOnDestroy(): void { clearInterval(this.timer); this.controller.destroy(); }
}
