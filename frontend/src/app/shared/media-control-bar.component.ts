import { ChangeDetectionStrategy, Component, output } from "@angular/core";

import { MediaPublicationService } from "../webrtc/media-publication.service";
import { RoomSessionService } from "../webrtc/room-session.service";

@Component({
  selector: "app-media-control-bar",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="media-control-bar" aria-label="Mediensteuerung">
      <button id="toggle-microphone" class="media-control" [class.active]="media.active('microphone')" type="button" [disabled]="!session.joined() || !!media.pending()" [attr.aria-pressed]="media.active('microphone')" (click)="media.toggle('microphone')">
        <span class="control-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3M8 21h8"/></svg></span>
        <span>{{ media.active('microphone') ? 'Mikrofon stoppen' : 'Mikrofon starten' }}</span>
      </button>
      <button id="toggle-camera" class="media-control" [class.active]="media.active('camera')" type="button" [disabled]="!session.joined() || !!media.pending()" [attr.aria-pressed]="media.active('camera')" (click)="media.toggle('camera')">
        <span class="control-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/></svg></span>
        <span>{{ media.active('camera') ? 'Kamera stoppen' : 'Kamera starten' }}</span>
      </button>
      <button id="toggle-screen" class="media-control" [class.active]="media.active('screen')" type="button" [disabled]="!session.joined() || !!media.pending()" [attr.aria-pressed]="media.active('screen')" (click)="media.toggle('screen')">
        <span class="control-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M9 10l3-3 3 3M12 7v7"/></svg></span>
        <span>{{ media.active('screen') ? 'Bildschirmfreigabe stoppen' : 'Bildschirm teilen' }}</span>
      </button>
      <span class="control-divider" aria-hidden="true"></span>
      <button id="leave-room" class="media-control leave" type="button" [disabled]="!session.joined()" (click)="leaveRoom.emit()">
        <span class="control-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 15a11 11 0 0114 0M7 14l-2 4-3-2M17 14l2 4 3-2"/></svg></span>
        <span>Verlassen</span>
      </button>
    </div>
  `,
})
export class MediaControlBarComponent {
  readonly leaveRoom = output<void>();

  constructor(
    readonly session: RoomSessionService,
    readonly media: MediaPublicationService,
  ) {}
}
