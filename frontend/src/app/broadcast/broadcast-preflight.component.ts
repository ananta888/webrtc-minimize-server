import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, input } from "@angular/core";

import { MediaStreamDirective } from "../shared/media-stream.directive";
import { BroadcastOwnSourcePreflightService } from "./broadcast-own-source-preflight.service";

@Component({
  selector: "app-broadcast-preflight",
  standalone: true,
  imports: [MediaStreamDirective],
  templateUrl: "./broadcast-preflight.component.html",
  styleUrl: "./broadcast-preflight.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BroadcastPreflightComponent implements OnInit, OnDestroy {
  readonly joined = input(false);
  readonly captionsActive = input(false);

  constructor(readonly preflight: BroadcastOwnSourcePreflightService) {}

  ngOnInit(): void {
    this.preflight.setPanelVisible(true);
  }

  ngOnDestroy(): void {
    this.preflight.setPanelVisible(false);
    void this.preflight.stopPreview("panel-close");
  }

  setSourceSelected(sourceId: string, selected: boolean): void {
    this.preflight.setSourceSelected(sourceId, selected);
  }

  async preparePreview(): Promise<void> {
    try {
      await this.preflight.preparePreview("user-action");
    } catch {
      // The service exposes its bounded errorCode for the visible panel.
    }
  }

  async stopPreview(): Promise<void> {
    try {
      await this.preflight.stopPreview();
    } catch {
      // A retained cleanup handle can be retried with the same visible action.
    }
  }
}
