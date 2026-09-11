import { Injectable, OnDestroy, signal } from "@angular/core";
import { SignalingService } from "../webrtc/signaling.service";
import { NativeSourceProgramService } from "./native-source-program.service";
import { SourceModerationController, SourceModerationView } from "./source-moderation-controller";

@Injectable()
export class SourceModerationService implements OnDestroy {
  readonly view = signal<SourceModerationView>({ phase: "idle", state: null });
  readonly controller: SourceModerationController;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(readonly programs: NativeSourceProgramService, signaling: SignalingService) {
    this.controller = new SourceModerationController({ context: () => {
      const context = programs.sceneContext();
      return context ? { key: JSON.stringify([context.key, context.program.programRevision]),
        programId: context.program.programId, programEpoch: context.program.programEpoch } : null;
    }, send: message => signaling.sendSourceControl(message), changed: view => this.view.set(view) });
    this.unsubscribe = signaling.subscribe(message => {
      if (message.type.startsWith("broadcast-source-moderation-")) this.controller.receive(message);
    });
    this.timer = setInterval(() => this.controller.tick(), 250);
  }
  ngOnDestroy(): void { clearInterval(this.timer); this.unsubscribe(); this.controller.destroy(); }
}
