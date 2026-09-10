import { ChangeDetectionStrategy, Component, OnChanges, OnDestroy, computed, input, signal } from "@angular/core";
import { NativePackagerStandbyService } from "./native-packager-standby.service";

@Component({
  selector: "app-native-packager-standby", standalone: true,
  providers: [NativePackagerStandbyService], changeDetection: ChangeDetectionStrategy.OnPush,
  // Static disabled protects creation before deferred input bindings settle.
  template: `
    <section class="panel" aria-labelledby="broadcast-standby-heading">
      <h2 id="broadcast-standby-heading">Standby-Geräte vormerken</h2>
      <p>Bis zu zwei eigene, für diesen Raum freigegebene Geräte. Eine Vormerkung startet keine Übertragung,
        vergibt keine Schlüssel und reserviert keine Kapazität. Die Übernahme bleibt ein gesondert bestätigter Packager-Wechsel.</p>
      <button id="broadcast-standby-load" type="button" class="button secondary" disabled
        [disabled]="disabled() || standby.busy()" (click)="load()">Auswahl vom Server laden</button>
      @if (standby.control(); as current) {
        <fieldset [disabled]="disabled() || standby.busy()">
          <legend>Standbys · {{ standby.selected().length }}/2</legend>
          @for (candidate of options(); track candidate.id) {
            <label>
              <input type="checkbox" [attr.data-standby-id]="candidate.id"
                [checked]="standby.selected().includes(candidate.id)"
                [disabled]="!standby.selected().includes(candidate.id) && (!candidate.available || standby.selected().length >= 2)"
                (change)="toggle(candidate.id, $any($event.target).checked)">
              {{ candidate.label }}{{ candidate.available ? '' : ' · aktuell nicht auswählbar' }}
            </label>
          } @empty { <p>Keine weiteren geeigneten eigenen Geräte vorhanden.</p> }
          @if (outputPolicy(); as policy) {
            <p id="broadcast-standby-pinned-output">Festgelegte Ausgabe: {{ policy.requestedRenditions }} Qualitätsstufe(n) · Hardwarebeschleunigung {{ policy.allowHardwareAcceleration ? 'erlaubt' : 'nicht erlaubt' }}.
              Die Vormerkung verwendet die Wahl der laufenden Sendung, nicht neue Formulareinstellungen.</p>
          } @else {
          <label for="broadcast-standby-renditions">Qualitätsstufen für die Eignungsprüfung</label>
          <select id="broadcast-standby-renditions" [value]="renditions()" (change)="setRenditions($any($event.target).value)">
            <option value="1">Eine Stufe</option><option value="2">Zwei Stufen</option><option value="3">Drei Stufen</option>
          </select>
          }
          <button id="broadcast-standby-save" type="button" class="button secondary"
            [disabled]="!canSave()" (click)="save()">Auswahl bestätigen…</button>
        </fieldset>
        <p id="broadcast-standby-status" role="status" aria-live="polite">Serverstand {{ current.standbyRevision }}:
          {{ current.standbyPackagerIds.length }} Vormerkungen. {{ changed() ? 'Änderungen noch nicht gespeichert.' : 'Auswahl synchronisiert.' }}</p>
      }
      @if (standby.error()) { <p id="broadcast-standby-error" class="error" role="alert">{{ standby.error() }} · Bitte den Serverstand erneut laden.</p> }
      <p class="policy-note">Abwählen aller Geräte und Bestätigen entfernt die Vormerkung. Stop, Raumwechsel und eine neue Ausgabe-Epoche verwerfen sie.
        Online-Status und Eignung können sich ändern; der Zielrechner benötigt weiterhin Zugang zum Broadcast-Origin.</p>
    </section>
  `,
})
export class NativePackagerStandbyComponent implements OnChanges, OnDestroy {
  readonly programId = input("");
  readonly programEpoch = input(0);
  readonly disabled = input(true);
  readonly candidates = input<readonly Readonly<{ id: string; label: string }>[]>([]);
  readonly outputPolicy = input<Readonly<{ requestedRenditions: number; allowHardwareAcceleration: boolean }> | null>(null);
  readonly renditions = signal(1);
  readonly changed = computed(() => Boolean(this.standby.control())
    && JSON.stringify(this.standby.selected()) !== JSON.stringify(this.standby.control()?.standbyPackagerIds));
  readonly validPolicy = computed(() => !this.outputPolicy() || (Number.isSafeInteger(this.outputPolicy()!.requestedRenditions)
    && this.outputPolicy()!.requestedRenditions >= 1 && this.outputPolicy()!.requestedRenditions <= 3
    && typeof this.outputPolicy()!.allowHardwareAcceleration === "boolean"));
  readonly canSave = computed(() => !this.disabled() && this.validPolicy() && !this.standby.busy() && this.changed()
    && this.standby.selected().every(id => this.candidates().some(candidate => candidate.id === id)));
  readonly options = computed(() => {
    const candidates = this.candidates().map(candidate => ({ ...candidate, available: true }));
    return [...candidates, ...this.standby.selected().filter(id => !candidates.some(candidate => candidate.id === id))
      .map(id => ({ id, label: "Zuvor vorgemerktes Gerät", available: false }))];
  });
  constructor(readonly standby: NativePackagerStandbyService) {}
  ngOnChanges(): void { this.standby.setScope(this.disabled() ? "" : this.programId(), this.programEpoch()); }
  ngOnDestroy(): void { this.standby.reset(); }
  setRenditions(value: string): void { if (!this.outputPolicy() && ["1", "2", "3"].includes(value)) this.renditions.set(Number(value)); }
  toggle(id: string, enabled: boolean): void {
    if (this.disabled() || (enabled && !this.candidates().some(candidate => candidate.id === id))) return;
    this.standby.select(id, enabled);
  }
  async load(): Promise<void> {
    if (this.disabled() || this.standby.busy()) return;
    try { await this.standby.load("user-action"); } catch { /* Lifecycle may have changed during the local action. */ }
  }
  async save(): Promise<void> {
    if (!this.canSave()) return;
    const control = this.standby.control(), selected = JSON.stringify(this.standby.selected()), policy = this.outputPolicy();
    const renditions = policy?.requestedRenditions ?? this.renditions();
    const programId = this.programId(), epoch = this.programEpoch();
    if (!window.confirm("Diese Standby-Auswahl für die aktuelle Sendung speichern? Es werden keine Medien oder Schlüssel an die vorgemerkten Geräte gesendet. Eine Übernahme benötigt weiterhin eine eigene Bestätigung.")) return;
    if (!this.canSave() || this.programId() !== programId || this.programEpoch() !== epoch
      || this.standby.control() !== control || JSON.stringify(this.standby.selected()) !== selected
      || JSON.stringify(this.outputPolicy()) !== JSON.stringify(policy)
      || (!policy && this.renditions() !== renditions)) return;
    try {
      if (policy) await this.standby.save(renditions, "user-action", policy.allowHardwareAcceleration);
      else await this.standby.save(renditions, "user-action");
    } catch { /* Server state must be loaded again after scope loss. */ }
  }
}
