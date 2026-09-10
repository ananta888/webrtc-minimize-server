import { Injectable, OnDestroy, signal } from "@angular/core";
import { BroadcastControlPlaneService } from "./broadcast-control-plane.service";
import { NativeSourceProgramService } from "./native-source-program.service";
import { NativeSceneView, NativeSourceSceneController } from "./native-source-scene-controller";

@Injectable()
export class NativeSourceSceneService implements OnDestroy {
  readonly view = signal<NativeSceneView>({ phase: "idle", scene: null });
  readonly controller: NativeSourceSceneController;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly programs: NativeSourceProgramService, control: BroadcastControlPlaneService) {
    this.controller = new NativeSourceSceneController({ context: () => programs.sceneContext(),
      request: (program, selection, signal) => control.nativeSourceScene(program, selection, signal),
      changed: value => this.view.set(value) });
    this.timer = setInterval(() => this.controller.tick(), 250);
  }
  ownerKey(): string | null {
    const context = this.programs.sceneContext();
    return context ? JSON.stringify([context.key, context.program.programId,
      context.program.programRevision, context.program.programEpoch]) : null;
  }
  ngOnDestroy(): void { clearInterval(this.timer); this.controller.destroy(); }
}
