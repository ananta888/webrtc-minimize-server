import { Injectable, OnDestroy, signal } from "@angular/core";
import { BroadcastControlPlaneService } from "./broadcast-control-plane.service";
import { NativeSourceProgramService } from "./native-source-program.service";
import { NativeAudioView, NativeSourceAudioController } from "./native-source-audio-controller";

@Injectable()
export class NativeSourceAudioService implements OnDestroy {
  readonly view = signal<NativeAudioView>({ phase: "idle", audio: null });
  readonly controller: NativeSourceAudioController;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(programs: NativeSourceProgramService, control: BroadcastControlPlaneService) {
    this.controller = new NativeSourceAudioController({ context: () => programs.audioContext(),
      request: (program, selection, signal) => control.nativeSourceAudio(program, selection, signal), changed: value => this.view.set(value) });
    this.timer = setInterval(() => this.controller.tick(), 250);
  }
  ngOnDestroy(): void { clearInterval(this.timer); this.controller.destroy(); }
}
