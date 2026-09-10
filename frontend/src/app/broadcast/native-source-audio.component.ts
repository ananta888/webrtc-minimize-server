import { ChangeDetectionStrategy, ChangeDetectorRef, Component, computed, signal } from "@angular/core";
import { NativeSourceAudioService } from "./native-source-audio.service";
import { NATIVE_AUDIO_STRATEGIES, NativeAudioLevel, NativeAudioSelection, NativeAudioState, NativeAudioStrategy, validAudioSelection } from "./native-source-audio-contract";
import { audioDraftRefresh, sameAudioScope, sameAudioSettings } from "./native-source-audio-draft";

@Component({ selector: "app-native-source-audio", standalone: true, providers: [NativeSourceAudioService],
  templateUrl: "./native-source-audio.component.html", changeDetection: ChangeDetectionStrategy.OnPush })
export class NativeSourceAudioComponent {
  readonly levels = signal<readonly NativeAudioLevel[]>([]);
  readonly strategy = signal<NativeAudioStrategy>("unprocessed");
  readonly strategies = NATIVE_AUDIO_STRATEGIES;
  readonly refreshing = signal(false);
  readonly draftConflict = signal(false);
  private readonly base = signal<NativeAudioState | null>(null);
  private readonly owner = signal<string | null>(null);
  readonly formState = computed(() => this.owner() && this.owner() === this.audio.ownerKey()
    ? this.audio.view().audio ?? this.base() : null);
  readonly editable = computed(() => !this.refreshing() && !!this.formState() && ["ready", "stale"].includes(this.audio.view().phase));
  readonly dirty = computed(() => !!this.base() && !!this.formState() && !sameAudioSettings(this.base()!, this.selection()!));
  readonly canApply = computed(() => {
    const current = this.audio.view().audio, base = this.base(), selection = this.selection();
    return this.editable() && this.audio.view().phase === "ready" && !this.draftConflict() && !!current && !!base && !!selection
      && sameAudioScope(base, current) && base.audioRevision === current.audioRevision && validAudioSelection(selection, current.audioControlVersion)
      && selection.sources.every(input => current.sources.some(source => source.sourceLeaseId === input.sourceLeaseId));
  });
  readonly strategyLabels: Record<NativeAudioStrategy, string> = {
    unprocessed: "Unbearbeitet · nur Einzelpegel", balanced: "Ausgewogen · Sprache leicht bevorzugen",
    "speech-first": "Sprache zuerst · Bildschirmton deutlich absenken", "screen-first": "Bildschirmton zuerst · Mikrofone deutlich absenken",
  };
  readonly status = computed(() => ({ idle: "Audiowerte noch nicht abgefragt.", pending: "Warte auf den aktuellen Packager…",
    ready: "Audiowerte bestätigt; höchstens fünf Sekunden aktuell.", stale: "Entwurf bleibt lokal bearbeitbar. Vor dem Anwenden Audiowerte neu abfragen.",
    conflict: "Nicht angewendet. Quellen oder Revision haben sich geändert; bitte neu abfragen.",
    unavailable: "Keine verlässliche Bestätigung. Rechte, Sendung und Packager mit Audio-Steuerung prüfen. Kein automatischer Wiederholungsversuch.",
  })[this.refreshing() ? "pending" : this.audio.view().phase]);
  constructor(readonly audio: NativeSourceAudioService, private readonly changeDetector: ChangeDetectorRef) {}
  async refresh(): Promise<void> {
    if (this.refreshing() || this.audio.view().phase === "pending") return;
    this.refreshing.set(true);
    try {
      this.changeDetector.detectChanges();
      const owner = this.audio.ownerKey();
      await this.audio.controller.refresh();
      const { phase, audio: state } = this.audio.view();
      if (phase !== "ready" || !state || !owner || owner !== this.audio.ownerKey()) return;
      const decision = this.owner() === owner ? audioDraftRefresh(this.base(), state, this.selection()) : "replace";
      if (decision === "replace") this.hydrate(state, owner);
      else {
        this.draftConflict.set(decision === "conflict");
        if (decision === "retain") this.base.set(state);
      }
    } finally { this.refreshing.set(false); }
  }
  private hydrate(state: NativeAudioState, owner: string): void {
    this.levels.set(state.sources.map(({ sourceLeaseId, leftGainQ15, rightGainQ15, muted }) => ({ sourceLeaseId, leftGainQ15, rightGainQ15, muted })));
    this.strategy.set(state.mix?.strategy ?? "unprocessed"); this.base.set(state); this.owner.set(owner); this.draftConflict.set(false);
  }
  reviewDraft(keep: boolean): void {
    const state = this.audio.view().audio, owner = this.audio.ownerKey();
    if (this.refreshing() || this.audio.view().phase !== "ready" || !state || !owner || owner !== this.owner()) return;
    if (keep && (!this.base() || !sameAudioScope(this.base()!, state))) return;
    if (!window.confirm(keep ? "Audioentwurf gegen die neu bestätigte Revision prüfen? Das ändert noch keinen Ausgangspegel."
      : "Audioentwurf verwerfen und die aktuell bestätigten Werte übernehmen?")) return;
    if (this.audio.view().phase !== "ready" || this.audio.view().audio !== state || this.audio.ownerKey() !== owner) return;
    if (keep) { this.base.set(state); this.draftConflict.set(false); }
    else this.hydrate(state, owner);
  }
  setStrategy(value: string): void {
    if (this.editable() && (this.formState()?.audioControlVersion ?? 0) >= 2
      && this.strategies.includes(value as NativeAudioStrategy)) this.strategy.set(value as NativeAudioStrategy);
  }
  setGain(id: string, channel: "leftGainQ15" | "rightGainQ15", text: string): string {
    const percent = Number(text);
    if (this.editable() && text.trim() && Number.isFinite(percent) && percent >= 0 && percent <= 100) {
      this.levels.update(values => values.map(value => value.sourceLeaseId === id ? { ...value, [channel]: Math.round(percent * 32768 / 100) } : value));
    }
    // Restore the actual staged value for blank/out-of-range input instead of
    // displaying a value which Apply would not send.
    const value = this.levels().find(source => source.sourceLeaseId === id)?.[channel];
    return value === undefined ? "" : String(this.percent(value));
  }
  setMuted(id: string, muted: boolean): void {
    if (!this.editable()) return;
    this.levels.update(values => values.map(value => value.sourceLeaseId === id ? { ...value, muted } : value));
  }
  percent(value: number): number { return Math.round(value * 1000 / 32768) / 10; }
  sourceLabel(id: string): string {
    const kind = this.base()?.sources.find(s => s.sourceLeaseId === id)?.sourceKind;
    return kind === "screen-audio" ? "Bildschirmton" : kind === "microphone" ? "Mikrofon" : "Nicht verfügbare Quelle";
  }
  sourceUnavailable(id: string): boolean {
    return this.audio.view().phase === "ready" && !!this.audio.view().audio
      && !this.audio.view().audio!.sources.some(source => source.sourceLeaseId === id);
  }
  removeUnavailable(id: string): void {
    if (!this.editable() || this.audio.view().phase !== "ready" || this.audio.view().audio?.sources.some(s => s.sourceLeaseId === id)) return;
    this.levels.update(values => values.filter(source => source.sourceLeaseId !== id));
  }
  private selection(): NativeAudioSelection | null {
    const audio = this.base();
    return audio ? { expectedAudioRevision: audio.audioRevision, sources: this.levels().map(s => ({ ...s })),
      ...(audio.audioControlVersion >= 2 ? { strategy: this.strategy() } : {}) } : null;
  }
  async apply(): Promise<void> {
    const selected = this.selection();
    if (!this.canApply() || !selected) return;
    const owner = this.audio.ownerKey(), observed = this.audio.view().audio;
    if (!window.confirm("Audioeinstellungen im Broadcast-Ausgang ändern? Raumton und Quellenfreigaben bleiben unverändert. Bereits ausgelieferter Ton kann nicht zurückgerufen werden.")) return;
    if (!this.canApply() || this.audio.ownerKey() !== owner || this.audio.view().audio !== observed
      || JSON.stringify(selected) !== JSON.stringify(this.selection())) return;
    const operation = this.audio.controller.apply(selected, "user-action");
    try { this.changeDetector.detectChanges(); }
    finally { await operation; }
  }
}
