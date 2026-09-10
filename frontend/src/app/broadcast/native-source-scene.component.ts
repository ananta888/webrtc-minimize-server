import { ChangeDetectionStrategy, Component, computed, signal } from "@angular/core";
import { NativeSourceSceneService } from "./native-source-scene.service";
import { NativeSceneSelection, SCENE_LAYOUTS, SceneLayout, SceneFit } from "./native-source-scene-contract";

@Component({ selector: "app-native-source-scene", standalone: true, providers: [NativeSourceSceneService],
  templateUrl: "./native-source-scene.component.html", changeDetection: ChangeDetectionStrategy.OnPush })
export class NativeSourceSceneComponent {
  readonly layout = signal<SceneLayout>("waiting-slate");
  readonly selected = signal<readonly string[]>([]);
  readonly active = signal("");
  readonly fits = signal<Readonly<Record<string, SceneFit>>>({});
  readonly refreshing = signal(false);
  readonly editable = computed(() => !this.refreshing() && this.scenes.view().phase === "ready");
  readonly layouts: ReadonlyArray<{ value: SceneLayout; label: string }> = [
    { value: "single", label: "Einzelquelle" }, { value: "screen-presenter", label: "Bildschirm mit Präsentation" },
    { value: "side-by-side", label: "Nebeneinander" }, { value: "active-speaker", label: "Ausgewählter Sprecher" },
    { value: "grid", label: "Raster" }, { value: "waiting-slate", label: "Wartebild" }, { value: "end-slate", label: "Endbild" },
  ];
  readonly status = computed(() => ({ idle: "Szenenzustand noch nicht abgefragt.", pending: "Warte auf den aktuellen Packager…",
    ready: "Szenenzustand bestätigt; höchstens fünf Sekunden aktuell.", stale: "Zustand bitte neu abfragen, bevor du weiter änderst.",
    conflict: "Szene nicht angewendet: Zustand neu abfragen und Auswahl prüfen.",
    unavailable: "Keine verlässliche Bestätigung. Rechte, aktuelle Sendung und Packager ab Version 0.9 prüfen. Nicht automatisch erneut anwenden.",
  })[this.refreshing() ? "pending" : this.scenes.view().phase]);
  constructor(readonly scenes: NativeSourceSceneService) {}
  async refresh(): Promise<void> {
    if (this.refreshing() || this.scenes.view().phase === "pending") return;
    // Controller-ready precedes this await continuation. Do not enable form
    // edits until its observation and the local draft agree atomically.
    this.refreshing.set(true);
    try {
      await this.scenes.controller.refresh();
      const { phase, scene: state } = this.scenes.view();
      if (phase === "ready" && state) {
        this.layout.set(state.layout); this.selected.set(state.sourceLeaseIds); this.active.set(state.activeSourceLeaseId);
        this.fits.set(Object.fromEntries(state.sourceLeaseIds.map((id, i) => [id, state.sourceFits?.[i] ?? "contain"])));
      }
    } finally { this.refreshing.set(false); }
  }
  setLayout(value: string): void {
    if (!this.editable() || !SCENE_LAYOUTS.includes(value as SceneLayout)) return;
    this.layout.set(value as SceneLayout);
    if (!["single", "active-speaker"].includes(value)) this.active.set("");
  }
  select(id: string, checked: boolean): void {
    if (!this.editable() || !this.scenes.view().scene?.availableSources.some(s => s.sourceLeaseId === id)) return;
    const next = this.selected().filter(s => s !== id);
    if (checked) next.push(id);
    if (next.length > 20) return;
    this.selected.set(next);
    if (checked && !this.fits()[id]) this.fits.set({ ...this.fits(), [id]: "contain" });
    if (!next.includes(this.active())) this.active.set("");
  }
  remove(id: string): void {
    if (!this.editable()) return;
    this.selected.set(this.selected().filter(s => s !== id));
    if (this.active() === id) this.active.set("");
  }
  private selection(): NativeSceneSelection | null {
    const scene = this.scenes.view().scene;
    return scene ? { expectedSceneRevision: scene.sceneRevision, layout: this.layout(), sourceLeaseIds: [...this.selected()], activeSourceLeaseId: this.active(),
      ...(scene.sceneControlVersion === 2 ? { sourceFits: this.selected().map(id => this.fits()[id] ?? "contain") } : {}) } : null;
  }
  setFit(id: string, value: string): void {
    if (!this.editable() || this.scenes.view().scene?.sceneControlVersion !== 2
      || !this.selected().includes(id) || !["contain", "cover"].includes(value)) return;
    this.fits.set({ ...this.fits(), [id]: value as SceneFit });
  }
  setActive(id: string): void {
    if (!this.editable() || (id !== "" && !this.selected().includes(id))) return;
    this.active.set(id);
  }
  async apply(): Promise<void> {
    const selection = this.selection();
    if (!this.editable() || !selection) return;
    if (!window.confirm("Diese Szene in der laufenden Sendung ändern? Es werden nur bereits freigegebene Quellen verwendet. "
      + "Ein Warte-/Endbild beendet die Sendung nicht. Die Bestätigung des Packagers ist kein Zustellnachweis beim Publikum.")) return;
    if (JSON.stringify(selection) !== JSON.stringify(this.selection())) return;
    await this.scenes.controller.apply(selection, "user-action");
  }
}
