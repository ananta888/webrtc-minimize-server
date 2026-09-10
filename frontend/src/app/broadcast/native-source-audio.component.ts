import { ChangeDetectionStrategy, Component, computed, signal } from "@angular/core";
import { NativeSourceAudioService } from "./native-source-audio.service";
import { NATIVE_AUDIO_STRATEGIES, NativeAudioLevel, NativeAudioSelection, NativeAudioStrategy } from "./native-source-audio-contract";

@Component({ selector: "app-native-source-audio", standalone: true, providers: [NativeSourceAudioService],
  templateUrl: "./native-source-audio.component.html", changeDetection: ChangeDetectionStrategy.OnPush })
export class NativeSourceAudioComponent {
  readonly levels = signal<readonly NativeAudioLevel[]>([]);
  readonly strategy = signal<NativeAudioStrategy>("unprocessed");
  readonly strategies = NATIVE_AUDIO_STRATEGIES;
  readonly strategyLabels: Record<NativeAudioStrategy, string> = {
    unprocessed: "Unbearbeitet · nur Einzelpegel", balanced: "Ausgewogen · Sprache leicht bevorzugen",
    "speech-first": "Sprache zuerst · Bildschirmton deutlich absenken", "screen-first": "Bildschirmton zuerst · Mikrofone deutlich absenken",
  };
  readonly status = computed(() => ({ idle: "Audiowerte noch nicht abgefragt.", pending: "Warte auf den aktuellen Packager…",
    ready: "Audiowerte bestätigt; höchstens fünf Sekunden aktuell.", stale: "Audiowerte vor einer weiteren Änderung neu abfragen.",
    conflict: "Nicht angewendet. Quellen oder Revision haben sich geändert; bitte neu abfragen.",
    unavailable: "Keine verlässliche Bestätigung. Rechte, Sendung und Packager mit Audio-Steuerung prüfen. Kein automatischer Wiederholungsversuch.",
  })[this.audio.view().phase]);
  constructor(readonly audio: NativeSourceAudioService) {}
  async refresh(): Promise<void> {
    await this.audio.controller.refresh();
    this.levels.set((this.audio.view().audio?.sources ?? []).map(({ sourceLeaseId, leftGainQ15, rightGainQ15, muted }) => ({ sourceLeaseId, leftGainQ15, rightGainQ15, muted })));
    this.strategy.set(this.audio.view().audio?.mix?.strategy ?? "unprocessed");
  }
  setStrategy(value: string): void {
    if (this.audio.view().phase === "ready" && (this.audio.view().audio?.audioControlVersion ?? 0) >= 2
      && this.strategies.includes(value as NativeAudioStrategy)) this.strategy.set(value as NativeAudioStrategy);
  }
  setGain(id: string, channel: "leftGainQ15" | "rightGainQ15", text: string): void {
    const percent = Number(text);
    if (this.audio.view().phase !== "ready" || !Number.isFinite(percent) || percent < 0 || percent > 100) return;
    this.levels.update(values => values.map(value => value.sourceLeaseId === id ? { ...value, [channel]: Math.round(percent * 32768 / 100) } : value));
  }
  setMuted(id: string, muted: boolean): void {
    if (this.audio.view().phase !== "ready") return;
    this.levels.update(values => values.map(value => value.sourceLeaseId === id ? { ...value, muted } : value));
  }
  percent(value: number): number { return Math.round(value * 1000 / 32768) / 10; }
  sourceLabel(id: string): string { return this.audio.view().audio?.sources.find(s => s.sourceLeaseId === id)?.sourceKind === "screen-audio" ? "Bildschirmton" : "Mikrofon"; }
  private selection(): NativeAudioSelection | null {
    const audio = this.audio.view().audio;
    return audio ? { expectedAudioRevision: audio.audioRevision, sources: this.levels().map(s => ({ ...s })),
      ...(audio.audioControlVersion >= 2 ? { strategy: this.strategy() } : {}) } : null;
  }
  async apply(): Promise<void> {
    const selected = this.selection();
    if (this.audio.view().phase !== "ready" || !selected || !selected.sources.length && selected.strategy === undefined) return;
    if (!window.confirm("Audioeinstellungen im Broadcast-Ausgang ändern? Raumton und Quellenfreigaben bleiben unverändert. Bereits ausgelieferter Ton kann nicht zurückgerufen werden.")) return;
    if (JSON.stringify(selected) !== JSON.stringify(this.selection())) return;
    await this.audio.controller.apply(selected, "user-action");
  }
}
