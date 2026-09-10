import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { NativeSourceProgramService } from "./native-source-program.service";
import type { NativeSourceProgramRequest } from "./native-source-program-controller";
import { NativeSourceSceneComponent } from "./native-source-scene.component";
import { NativeSourceAudioComponent } from "./native-source-audio.component";
import { NativeSourceAudioOutput, normalizeSourceAudioOutput } from "./native-source-audio-output";
import { supportsSourceAudioOutput } from "./native-source-audio-capability";

@Component({
  selector: "app-native-source-program", standalone: true,
  imports: [NativeSourceSceneComponent, NativeSourceAudioComponent],
  templateUrl: "./native-source-program.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NativeSourceProgramComponent {
  readonly disabled = input(true);
  readonly roomId = input("");
  readonly title = signal("Meine Mehrquellen-Sendung");
  readonly visibility = signal<NativeSourceProgramRequest["visibility"]>("private");
  readonly packagerId = signal("");
  readonly renditions = signal(1);
  readonly hardware = signal(false);
  readonly audioPreset = signal<"legacy" | "speech" | "balanced" | "music" | "custom">("legacy");
  readonly audioChannels = signal(2);
  readonly audioKbps = signal(96);
  readonly audioSupported = computed(() => supportsSourceAudioOutput(this.selected()?.capability));
  readonly audioOutput = computed<NativeSourceAudioOutput | null>(() => {
    const preset = this.audioPreset();
    if (preset === "legacy") return null;
    const [channels, kbps] = preset === "speech" ? [1, 48] : preset === "balanced" ? [2, 96]
      : preset === "music" ? [2, 192] : [this.audioChannels(), this.audioKbps()];
    try { return normalizeSourceAudioOutput({ codec: "aac", sampleRate: 48000, channels, targetBitsPerSecond: kbps * 1000 }); }
    catch { return null; }
  });
  readonly error = signal("");
  readonly selected = computed(() => this.programs.candidates().find(p => p.id === this.packagerId()));
  readonly canStart = computed(() => !this.disabled() && !this.programs.view().active
    && !!this.title().trim() && this.title().length <= 80 && !!this.selected()
    && (this.audioPreset() === "legacy" || this.audioSupported() && !!this.audioOutput())
    && this.renditions() >= 1 && this.renditions() <= (this.selected()?.capability?.maximumRenditions ?? 0));
  readonly statusLabel = computed(() => {
    switch (this.programs.view().phase) {
      case "preparing": return "Startauftrag wird vorbereitet";
      case "waiting-output": return "Warte auf bestätigte Packager-Ausgabe";
      case "live": return "Ausgabe vom Packager bestätigt";
      case "degraded": return "Packager-Ausgabe beeinträchtigt";
      case "stopping": return "Sendung wird gestoppt";
      case "stopped": return "Sendung gestoppt";
      case "failed": return this.programs.view().active ? "Stopp nicht bestätigt – bitte erneut stoppen" : "Sendung fehlgeschlagen";
      default: return "Noch nicht gestartet";
    }
  });
  constructor(readonly programs: NativeSourceProgramService) {}

  setVisibility(value: string): void {
    if (value === "private" || value === "unlisted" || value === "public") this.visibility.set(value);
  }
  setRenditions(value: string): void {
    if (/^[123]$/.test(value)) this.renditions.set(Number(value));
  }
  setAudioPreset(value: string): void {
    if (value === "legacy" || value === "speech" || value === "balanced" || value === "music" || value === "custom") this.audioPreset.set(value);
  }
  private request(): NativeSourceProgramRequest {
    return { roomId: this.roomId(), title: this.title().trim(), visibility: this.visibility(), packagerId: this.packagerId(),
      requestedRenditions: this.renditions(), allowHardwareAcceleration: this.hardware(),
      ...(this.audioOutput() ? { audioOutput: this.audioOutput()! } : {}) };
  }
  async start(): Promise<void> {
    if (!this.canStart()) return;
    const request = this.request();
    if (!window.confirm(`Leere Mehrquellen-Sendung auf „${this.selected()!.label}“ starten? `
      + "Zunächst erscheint nur ein Platzhalter. Jede Quelle benötigt anschließend eine separate Zustimmung ihres Teilnehmers. "
      + "Der Trusted Packager kann diese freigegebenen Quellen entschlüsseln; die Ausgabe ans Publikum ist nicht SFrame-E2EE. "
      + "Rechenleistung und Upload des Packagers werden genutzt. Fortfahren?")) return;
    if (!this.canStart() || JSON.stringify(request) !== JSON.stringify(this.request())) return;
    this.error.set("");
    try { await this.programs.controller.start(request, "user-action"); }
    catch { this.error.set("native_source_program_start_denied"); }
  }
  async stop(): Promise<void> { await this.programs.controller.stop(); }
}
