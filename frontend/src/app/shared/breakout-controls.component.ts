import { ChangeDetectionStrategy, Component } from "@angular/core";

import { BreakoutSwitchService } from "../webrtc/breakout-switch.service";
import { RoomModerationService } from "../webrtc/room-moderation.service";
import { RoomSessionService } from "../webrtc/room-session.service";

@Component({
  selector: "app-breakout-controls",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (session.joined() && session.mode() === "room") {
      <section class="breakout-panel" aria-labelledby="breakout-heading">
        <div class="surface-heading small">
          <span class="feature-icon mint" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="3" y="13" width="7" height="7" rx="1"/><rect x="14" y="13" width="7" height="7" rx="1"/></svg></span>
          <div>
            <p class="eyebrow">Control Plane</p>
            <h2 id="breakout-heading">Breakouts</h2>
          </div>
        </div>
        @if (breakouts.phase() === "offered") {
          <p class="hint">Wechsel in einen isolierten Unterraum. Medien und Schlüssel werden zuerst gestoppt. Capture startet nicht.</p>
          <div class="whiteboard-tools">
            <button id="breakout-confirm" type="button" class="button primary compact" (click)="breakouts.confirm()">Wechseln</button>
            <button id="breakout-decline" type="button" class="button ghost compact" (click)="breakouts.decline()">Bleiben</button>
          </div>
        } @else if (breakouts.phase() === "switching") {
          <p class="hint">Wechsel: lokale Medien und PeerConnections werden beendet.</p>
        } @else if (breakouts.phase() === "stranded") {
          <p class="hint">Wechsel fehlgeschlagen. Keine Membership, keine Medien. Rückweg nur mit neuem Beitritt.</p>
        } @else if (isChildRoom()) {
          <p class="hint">Isolierter Unterraum. Rückkehr stoppt Medien zuerst. Capture startet nicht automatisch.</p>
          <div class="whiteboard-tools">
            <button id="breakout-return" type="button" class="button primary compact" (click)="breakouts.returnToParent()">Zurück zum Hauptraum</button>
            <button id="breakout-help" type="button" class="button ghost compact" (click)="breakouts.requestHelp()">Hilfe anfordern</button>
            @if (breakouts.helpAcknowledged()) {
              <span class="badge">Hilfe angefordert</span>
            }
          </div>
        } @else if (breakouts.canOpen() && !breakouts.setSnapshot()) {
          <p class="hint">Unterräume sind vom Hauptraum getrennt. Capture startet nicht.</p>
          <button id="breakout-open" type="button" class="button ghost compact" (click)="breakouts.open()">Breakouts öffnen</button>
        } @else if (breakouts.canOpen() && children().length > 0) {
          <p class="hint">Zuweisung bindet Person und Gerät. Erraten des Unterraum-Codes ersetzt keinen Grant.</p>
          @if (breakouts.helpNotified(); as help) {
            <div class="breakout-help-banner" role="alert">
              <p>Hilferuf aus Raum {{ help.childRoomId.slice(-6) }}</p>
              <button id="breakout-help-dismiss" type="button" class="button ghost compact" (click)="breakouts.dismissHelp()">Bestätigen</button>
            </div>
          }
          <div class="whiteboard-tools">
            <button id="breakout-balanced" type="button" class="button ghost compact" (click)="breakouts.assignBalanced()">Ausgewogen verteilen</button>
            @for (child of children(); track child) {
              <button type="button" class="button ghost compact" [attr.id]="'breakout-child-' + child"
                (click)="assignFirst(child)">Zu {{ child.slice(-6) }}</button>
            }
          </div>
        } @else if (!breakouts.canOpen && children().length > 0) {
          <p class="hint">Freiwillige Unterraumwahl. Beitritt erfordert Bestätigung.</p>
          <div class="whiteboard-tools">
            @for (child of children(); track child) {
              <button type="button" class="button ghost compact" [attr.id]="'breakout-choose-' + child"
                (click)="breakouts.choose(child)">{{ child.slice(-6) }} beitreten</button>
            }
          </div>
        }
      </section>
    }
  `,
})
export class BreakoutControlsComponent {
  constructor(
    readonly session: RoomSessionService,
    readonly breakouts: BreakoutSwitchService,
    private readonly moderation: RoomModerationService,
  ) {}

  isChildRoom(): boolean {
    return this.session.roomId().startsWith("brk-");
  }

  children(): string[] {
    const snapshot = this.breakouts.setSnapshot();
    const items = snapshot?.["children"];
    if (!Array.isArray(items)) return [];
    return items.map((item) => item && typeof item === "object" ? String((item as { roomId?: string }).roomId || "") : "")
      .filter((roomId) => roomId.startsWith("brk-"));
  }

  assignFirst(childRoomId: string): void {
    const target = this.moderation.participants().find((item) => item.role === "participant");
    if (target) this.breakouts.assign(target.peerId, childRoomId);
  }
}
