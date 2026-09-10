import { ChangeDetectionStrategy, Component, computed, signal } from "@angular/core";
import { NativeSourceSceneService } from "./native-source-scene.service";
import { NativeSceneSelection, NativeSceneState, SCENE_LAYOUTS, SceneLayout, SceneFit, validSceneSelection } from "./native-source-scene-contract";
import { sameScenePresentation, sameSceneScope, sceneDraftRefresh } from "./native-source-scene-draft";

@Component({ selector: "app-native-source-scene", standalone: true, providers: [NativeSourceSceneService],
  templateUrl: "./native-source-scene.component.html", changeDetection: ChangeDetectionStrategy.OnPush })
export class NativeSourceSceneComponent {
  readonly layout = signal<SceneLayout>("waiting-slate");
  readonly selected = signal<readonly string[]>([]);
  readonly active = signal("");
  readonly fits = signal<Readonly<Record<string, SceneFit>>>({});
  readonly refreshing = signal(false);
  private readonly base = signal<NativeSceneState | null>(null);
  private readonly owner = signal<string | null>(null);
  readonly draftConflict = signal(false);
  readonly formState = computed(() => this.owner() && this.owner() === this.scenes.ownerKey()
    ? this.scenes.view().scene ?? this.base() : null);
  readonly editable = computed(() => !this.refreshing() && !!this.formState()
    && ["ready", "stale"].includes(this.scenes.view().phase));
  readonly dirty = computed(() => !!this.base() && !!this.formState() && !sameScenePresentation(this.base()!, this.selection()!));
  readonly canApply = computed(() => {
    const current = this.scenes.view().scene, base = this.base();
    return this.editable() && this.scenes.view().phase === "ready" && !this.draftConflict()
      && !!current && !!base && sameSceneScope(base, current) && base.sceneRevision === current.sceneRevision
      && validSceneSelection(this.selection()!)
      && this.selected().every(id => current.availableSources.some(source => source.sourceLeaseId === id));
  });
  readonly layouts: ReadonlyArray<{ value: SceneLayout; label: string }> = [
    { value: "single", label: "Einzelquelle" }, { value: "screen-presenter", label: "Bildschirm mit Präsentation" },
    { value: "side-by-side", label: "Nebeneinander" }, { value: "active-speaker", label: "Ausgewählter Sprecher" },
    { value: "grid", label: "Raster" }, { value: "waiting-slate", label: "Wartebild" }, { value: "end-slate", label: "Endbild" },
  ];
  readonly status = computed(() => ({ idle: "Szenenzustand noch nicht abgefragt.", pending: "Warte auf den aktuellen Packager…",
    ready: "Szenenzustand bestätigt; höchstens fünf Sekunden aktuell.", stale: "Entwurf bleibt lokal bearbeitbar. Vor dem Anwenden Zustand bitte neu abfragen.",
    conflict: "Szene nicht angewendet: Zustand neu abfragen und Auswahl prüfen.",
    unavailable: "Keine verlässliche Bestätigung. Rechte, aktuelle Sendung und Packager ab Version 0.9 prüfen. Nicht automatisch erneut anwenden.",
  })[this.refreshing() ? "pending" : this.scenes.view().phase]);
  constructor(readonly scenes: NativeSourceSceneService) {}
  async refresh(): Promise<void> {
    if (this.refreshing() || this.scenes.view().phase === "pending") return;
    // Controller-ready precedes this await continuation. Do not enable form
    // edits until its observation and the local draft agree atomically.
    this.refreshing.set(true);
    const owner = this.scenes.ownerKey();
    try {
      await this.scenes.controller.refresh();
      const { phase, scene: state } = this.scenes.view();
      if (phase === "ready" && state && owner && owner === this.scenes.ownerKey()) {
        const decision = this.owner() === owner ? sceneDraftRefresh(this.base(), state, this.selection()) : "replace";
        if (decision === "replace") this.hydrate(state, owner);
        else {
          this.draftConflict.set(decision === "conflict");
          if (decision === "retain") this.base.set(state);
        }
      }
    } finally { this.refreshing.set(false); }
  }
  private hydrate(state: NativeSceneState, owner: string): void {
    this.layout.set(state.layout); this.selected.set(state.sourceLeaseIds); this.active.set(state.activeSourceLeaseId);
    this.fits.set(Object.fromEntries(state.sourceLeaseIds.map((id, i) => [id, state.sourceFits?.[i] ?? "contain"])));
    this.owner.set(owner); this.base.set(state); this.draftConflict.set(false);
  }
  reviewDraft(keep: boolean): void {
    const state = this.scenes.view().scene, owner = this.scenes.ownerKey();
    if (this.refreshing() || this.scenes.view().phase !== "ready" || !state || !owner || this.owner() !== owner) return;
    if (keep && (!this.base() || !sameSceneScope(this.base()!, state))) return;
    if (!window.confirm(keep ? "Lokalen Entwurf gegen die neu bestätigte Szenenrevision prüfen? Das wendet noch keine Szene an."
      : "Lokalen Entwurf verwerfen und die aktuell bestätigte Szene übernehmen?")) return;
    if (this.scenes.view().phase !== "ready" || this.scenes.view().scene !== state || this.scenes.ownerKey() !== owner) return;
    if (keep) { this.base.set(state); this.draftConflict.set(false); }
    else this.hydrate(state, owner);
  }
  setLayout(value: string): void {
    if (!this.editable() || !SCENE_LAYOUTS.includes(value as SceneLayout)) return;
    this.layout.set(value as SceneLayout);
    if (!["single", "active-speaker"].includes(value)) this.active.set("");
  }
  select(id: string, checked: boolean): void {
    if (!this.editable() || !this.formState()?.availableSources.some(s => s.sourceLeaseId === id)) return;
    const next = this.selected().filter(s => s !== id);
    if (checked) next.push(id);
    if (next.length > 20) return;
    this.selected.set(next);
    if (checked && !this.fits()[id]) this.fits.set({ ...this.fits(), [id]: "contain" });
    if (!checked) this.dropFit(id);
    if (!next.includes(this.active())) this.active.set("");
  }
  remove(id: string): void {
    if (!this.editable()) return;
    this.selected.set(this.selected().filter(s => s !== id));
    this.dropFit(id);
    if (this.active() === id) this.active.set("");
  }
  private dropFit(id: string): void {
    const fits = { ...this.fits() }; delete fits[id]; this.fits.set(fits);
  }
  private selection(): NativeSceneSelection | null {
    const scene = this.base();
    return scene ? { expectedSceneRevision: scene.sceneRevision, layout: this.layout(), sourceLeaseIds: [...this.selected()], activeSourceLeaseId: this.active(),
      ...(scene.sceneControlVersion === 2 ? { sourceFits: this.selected().map(id => this.fits()[id] ?? "contain") } : {}) } : null;
  }
  setFit(id: string, value: string): void {
    if (!this.editable() || this.formState()?.sceneControlVersion !== 2
      || !this.selected().includes(id) || !["contain", "cover"].includes(value)) return;
    this.fits.set({ ...this.fits(), [id]: value as SceneFit });
  }
  setActive(id: string): void {
    if (!this.editable() || (id !== "" && !this.selected().includes(id))) return;
    this.active.set(id);
  }
  async apply(): Promise<void> {
    const selection = this.selection();
    if (!this.canApply() || !selection) return;
    const owner = this.scenes.ownerKey(), observed = this.scenes.view().scene;
    if (!window.confirm("Diese Szene in der laufenden Sendung ändern? Es werden nur bereits freigegebene Quellen verwendet. "
      + "Ein Warte-/Endbild beendet die Sendung nicht. Die Bestätigung des Packagers ist kein Zustellnachweis beim Publikum.")) return;
    if (!this.canApply() || this.scenes.ownerKey() !== owner || this.scenes.view().scene !== observed
      || JSON.stringify(selection) !== JSON.stringify(this.selection())) return;
    await this.scenes.controller.apply(selection, "user-action");
  }
}
