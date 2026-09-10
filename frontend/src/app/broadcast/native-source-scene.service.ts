import { Injectable, OnDestroy, signal } from "@angular/core";
import { BroadcastControlPlaneService } from "./broadcast-control-plane.service";
import { NativeSourceProgramService } from "./native-source-program.service";
import { NativeSceneView, NativeSourceSceneController } from "./native-source-scene-controller";
import { NativeSceneState } from "./native-source-scene-contract";
import { NativeSourceLabelsController, NativeSourceLabelsView } from "./native-source-labels-controller";

@Injectable()
export class NativeSourceSceneService implements OnDestroy {
  readonly view = signal<NativeSceneView>({ phase: "idle", scene: null });
  readonly controller: NativeSourceSceneController;
  readonly labels = signal<NativeSourceLabelsView>({ phase: "idle", labels: null });
  private readonly labelController: NativeSourceLabelsController;
  private labelOwner: string | null = null;
  private labelScene: NativeSceneState | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly programs: NativeSourceProgramService, control: BroadcastControlPlaneService) {
    this.labelController = new NativeSourceLabelsController({ owner: () => this.ownerKey(), scene: () => this.view().scene,
      request: (scene, signal) => control.nativeSourceLabels(scene, signal), changed: value => {
        this.labelOwner = value.phase === "ready" ? this.ownerKey() : null;
        this.labelScene = value.phase === "ready" ? this.view().scene : null;
        this.labels.set(value);
      } });
    this.controller = new NativeSourceSceneController({ context: () => programs.sceneContext(),
      request: (program, selection, signal) => control.nativeSourceScene(program, selection, signal),
      changed: value => { this.view.set(value); this.labelController.observe(value.phase === "ready" ? value.scene : null); } });
    this.timer = setInterval(() => { this.controller.tick(); this.labelController.tick(); }, 250);
  }
  ownerKey(): string | null {
    const context = this.programs.sceneContext();
    return context ? JSON.stringify([context.key, context.program.programId,
      context.program.programRevision, context.program.programEpoch]) : null;
  }
  publisherName(sourceLeaseId: string): string | null {
    const view = this.view(), labels = this.labels(), now = Date.now();
    if (view.phase !== "ready" || !view.scene || view.scene !== this.labelScene || !this.labelOwner
      || this.labelOwner !== this.ownerKey() || now >= view.scene.observedAt + 5000 || now < view.scene.observedAt - 1000
      || labels.phase !== "ready") return null;
    const binding = labels.labels?.bindings.find(b => b.sourceLeaseId === sourceLeaseId);
    return binding ? this.programs.publisherName(binding.publisherPeerId) : null;
  }
  labelsStatus(): string {
    return { idle: "Teilnehmerzuordnung wird mit einer frischen Szene abgefragt.", pending: "Teilnehmerzuordnung wird geladen…",
      ready: "Namen stammen aus der aktuellen Raummembership und sind keine zusätzliche Freigabe.",
      unavailable: "Teilnehmerzuordnung nicht verfügbar. Quellen bleiben über ihre Referenz bedienbar; eine neue Szenenabfrage versucht die Zuordnung erneut.",
    }[this.labels().phase];
  }
  ngOnDestroy(): void { clearInterval(this.timer); this.controller.destroy(); this.labelController.destroy(); }
}
