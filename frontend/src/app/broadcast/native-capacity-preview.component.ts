import { ChangeDetectionStrategy, Component, OnDestroy, effect, input, signal } from "@angular/core";
import type { NativeSourceProgramRequest } from "./native-source-program-controller";
import { NativeSourceProgramService } from "./native-source-program.service";
import { CapacityPreviewState, NativeCapacityPreviewController } from "./native-capacity-preview-controller";

export const NATIVE_CAPACITY_PREVIEW_TEMPLATE = `
    <section aria-labelledby="native-capacity-heading">
      <h3 id="native-capacity-heading">Ausgabe und Ressourcen vor dem Start</h3>
      <button id="native-capacity-query" type="button" class="button secondary"
        [disabled]="!request() || state().phase === 'pending'" (click)="query()">Packager-Kapazität prüfen</button>
      <p role="status" aria-live="polite">{{ statusText() }}</p>
      @if (state().value; as preview) {
        @if (preview.schema === 'ananta.native-capacity-preview.v2') {
          <p>Programmlimits für einen zusätzlichen Start geprüft. Bereits laufende und noch startende Sendungen sind berücksichtigt.</p>
        } @else { <p>Ältere Vorschau: Programmlimits wurden nicht geprüft.</p> }
        <p>{{ preview.renditions.length }} von {{ preview.requestedRenditions }} gewünschten Qualitätsstufen ·
          {{ preview.videoEncoder === 'libx264' ? 'Software-Encoding' : 'Hardware-Encoding mit Software-Fallback' }}.</p>
        @if (preview.reduced) { <p>Die Packager-Fähigkeiten reduzieren die angefragte Anzahl an Qualitätsstufen.</p> }
        <ul>
          @for (r of preview.renditions; track r.id) {
            <li>{{ r.width }} × {{ r.height }} · {{ r.framesPerSecond }} FPS ·
              Video {{ rate(r.videoBitsPerSecond) }} · Audio {{ rate(r.audioBitsPerSecond) }}
              ({{ r.audioChannels === 1 ? 'Mono' : 'Stereo' }})</li>
          }
        </ul>
        <p>Geplanter Packager-Egress aller Stufen: {{ rate(preview.demand.egressBitsPerSecond) }} einschließlich 15 % Puffer.
          Nicht der Gesamtdatenverkehr aller Zuschauer.</p>
        <p>Budgetbedarf: {{ preview.demand.cpuUnits }} CPU-Planeinheiten · {{ preview.demand.memoryMiB }} MiB ·
          {{ preview.demand.encoderSlots }} Encoder-Slots · {{ preview.demand.gpuSlots }} GPU-Slots.
          Planungswerte, keine Messung freier Hardware-Ressourcen.</p>
      }
      <p>Die Prüfung reserviert nichts und ist höchstens fünf Sekunden aktuell. Der Start prüft die Zulassung erneut.
        Zuschauer-Kapazität und Providerkosten sind durch diese Prüfung nicht zugesagt.
        Kosten: nicht berechenbar – keine Preis- oder Kostenfreigabe hinterlegt.</p>
    </section>
  `;
@Component({
  selector: "app-native-capacity-preview", standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: NATIVE_CAPACITY_PREVIEW_TEMPLATE,
})
export class NativeCapacityPreviewComponent implements OnDestroy {
  readonly request = input<NativeSourceProgramRequest | null>(null);
  readonly state = signal<CapacityPreviewState>({ phase: "idle", value: null });
  private readonly controller: NativeCapacityPreviewController;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly programs: NativeSourceProgramService) {
    this.controller = new NativeCapacityPreviewController({ context: () => this.context(),
      query: (request, signal) => programs.previewCapacity(request, signal), changed: state => this.state.set(state),
      now: () => performance.now() });
    this.timer = setInterval(() => this.controller.tick(), 250);
    effect(() => { this.context(); this.controller.tick(); });
  }
  private context() {
    const request = this.request(), key = request && this.programs.capacityContext(request);
    return key && request ? { key, request } : null;
  }
  query(): Promise<void> { return this.controller.query(); }
  rate(bits: number): string { return bits >= 1000000 ? `${(bits / 1000000).toFixed(2)} Mbit/s` : `${(bits / 1000).toFixed(1)} kbit/s`; }
  statusText(): string {
    switch (this.state().phase) {
      case "pending": return "Aktuelle Native-Admission wird geprüft…";
      case "current": return this.state().value?.schema === "ananta.native-capacity-preview.v2"
        ? "Native Ressourcen und Programmlimits zum Prüfzeitpunkt eingehalten. Keine Reservierung."
        : "Native Ressourcenbudgets zum Prüfzeitpunkt eingehalten. Keine Reservierung.";
      case "stale": return "Vorschau veraltet oder Auswahl/Sitzung geändert. Bitte erneut prüfen.";
      case "unavailable": return "Keine Kapazitätsbestätigung: Berechtigung, Raumfreigabe, Packager-Verfügbarkeit, Programm- oder Ressourcenlimit prüfen. Bei zu vielen Anfragen eine Minute warten.";
      default: return "Noch keine Kapazitätsprüfung für diese Auswahl.";
    }
  }
  ngOnDestroy(): void { clearInterval(this.timer); this.controller.destroy(); }
}
