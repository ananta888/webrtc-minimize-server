import { ChangeDetectionStrategy, Component, computed, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";

import { LocalMediaSource, MediaPublicationService } from "../webrtc/media-publication.service";
import { PeerMeshService } from "../webrtc/peer-mesh.service";
import { PresentationStageService } from "../webrtc/presentation-stage.service";
import { ModerationAction, ModerationAuditEntry, RoomModerationService } from "../webrtc/room-moderation.service";
import { RoomSessionService } from "../webrtc/room-session.service";
import {
  mediaObservationLabel,
  participantListRows,
  ParticipantHandFilter,
  ParticipantListRow,
  ParticipantRoleFilter,
} from "./room-participant-list";

@Component({
  selector: "app-room-participant-list",
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="participant-panel" aria-labelledby="participant-list-heading">
      <div class="surface-heading small">
        <span class="feature-icon mint" aria-hidden="true">
          <svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><circle cx="16" cy="9" r="2.4"/><path d="M4 18a5 5 0 0110 0M14 18a4.2 4.2 0 016 0"/></svg>
        </span>
        <div>
          <p class="eyebrow">Control Plane</p>
          <h2 id="participant-list-heading">Teilnehmer</h2>
        </div>
      </div>
      <p class="hint">Rollen und die Redereihenfolge kommen nur vom Server. Medienanzeigen sind lokale Beobachtungen und keine Rechte.</p>
      @if (session.mode() !== 'pair' && queueRows().length > 0) {
        <ol id="hand-queue" class="hand-queue" aria-label="Redereihenfolge">
          @for (item of queueRows(); track item.peerId) {
            <li>
              <span>{{ item.queuePosition }}. {{ item.name }}{{ item.own ? ' (du)' : '' }}</span>
              @if (canClear(item)) {
                <button type="button" class="button ghost compact" [attr.data-clear-hand]="item.peerId"
                  (click)="moderation.clear(item.peerId)">Hand senken</button>
              }
            </li>
          }
        </ol>
      }
      <label class="participant-search">Suchen
        <input id="participant-filter" type="search" maxlength="80" autocomplete="off"
          [ngModel]="query()" (ngModelChange)="query.set($event)" [disabled]="!session.joined()">
      </label>
      <div class="participant-filters">
        <label>Rolle
          <select id="participant-role-filter" [ngModel]="roleFilter()" (ngModelChange)="roleFilter.set($event)">
            <option value="all">Alle Rollen</option>
            <option value="owner">Nur Owner</option>
            <option value="participant">Nur Teilnehmer</option>
          </select>
        </label>
        <label>Hand
          <select id="participant-hand-filter" [ngModel]="handFilter()" (ngModelChange)="handFilter.set($event)">
            <option value="all">Alle</option>
            <option value="raised">Gehobene Hände</option>
          </select>
        </label>
      </div>
      <ul id="participant-list" class="participant-list" role="listbox" [attr.aria-label]="'Teilnehmerliste'">
        @for (item of visibleRows(); track item.peerId) {
          <li class="participant-row" role="option" [attr.aria-selected]="item.own"
            [attr.data-peer-id]="item.peerId" [attr.data-role]="item.role" [attr.data-hand]="item.hand">
            <div>
              <strong>{{ item.name }}{{ item.own ? ' · du' : '' }}</strong>
              <p>
                <span class="role-chip" [attr.data-source]="'server'">Raumrolle · {{ item.role === 'owner' ? 'Owner' : 'Teilnehmer' }}</span>
                @if (item.peerId === moderation.presenterPeerId()) {
                  <span class="stage-chip">Bühne</span>
                }
                @if (localPin() === item.peerId) {
                  <span class="pin-chip">Lokal angeheftet</span>
                }
                @if (item.hand === 'raised') {
                  <span class="hand-chip">Hand gehoben{{ item.queuePosition ? ' · Platz ' + item.queuePosition : '' }}</span>
                }
              </p>
              <p class="observation" [attr.data-kind]="item.mediaKind">
                @if (item.mediaKind === 'local') { Lokal gemessen: {{ sourceText(item.mediaSources) }} }
                @else if (item.mediaKind === 'received') { Empfangen: {{ sourceText(item.mediaSources) }} }
                @else { Keine lokale Medienbeobachtung }
              </p>
            </div>
            <div class="participant-actions">
              @if (canClear(item)) {
                <button type="button" class="button ghost compact" [attr.data-clear-hand]="item.peerId"
                  (click)="moderation.clear(item.peerId)">Hand senken</button>
              }
              <button type="button" class="button ghost compact" [attr.data-pin-peer]="item.peerId"
                [attr.aria-pressed]="localPin() === item.peerId" (click)="togglePin(item.peerId)">{{ localPin() === item.peerId ? 'Loslösen' : 'Anheften' }}</button>
              @if (canAssignPresenter(item)) {
                <button type="button" class="button ghost compact" [attr.data-assign-presenter]="item.peerId"
                  (click)="moderation.assignPresenter(item.peerId)">Bühne übergeben</button>
              }
              @if (canRemove(item)) {
                <button type="button" class="button ghost compact" [attr.data-remove-peer]="item.peerId"
                  (click)="askRemove(item)">Entfernen…</button>
                <button type="button" class="button ghost compact" [attr.data-stop-publication]="item.peerId"
                  (click)="askStop(item)">Publikation stoppen…</button>
              }
            </div>
          </li>
        } @empty {
          <li class="list-empty">{{ session.joined() ? 'Keine Treffer in der aktuellen Filterung.' : 'Noch keinem Raum beigetreten.' }}</li>
        }
      </ul>
      @if (moderation.pendingRemove(); as pending) {
        <div id="peer-remove-undo" class="remove-confirm" role="status">
          <p>Entfernen läuft noch {{ undoSeconds(pending.expiresAt) }}s. Membership bleibt bis dahin bestehen.</p>
          @if (moderation.ownRole() === 'owner') {
            <button id="peer-remove-undo-action" type="button" class="button ghost" (click)="moderation.cancelRemove()">Zurücknehmen</button>
          }
        </div>
      }
      @if (removeDraft(); as pending) {
        <div id="peer-remove-confirm" class="remove-confirm" role="alertdialog" aria-labelledby="peer-remove-heading">
          <h3 id="peer-remove-heading">{{ pending.name }} entfernen?</h3>
          <p>Raum {{ session.roomId() }}. Die Person verliert die Membership in dieser Instanz. Capture startet nicht.</p>
          <div class="inline-actions">
            <button id="peer-remove-cancel" type="button" class="button ghost" (click)="removeDraft.set(null)">Abbrechen</button>
            <button id="peer-remove-confirm-action" type="button" class="button primary" (click)="confirmRemove()">Entfernen</button>
          </div>
        </div>
      }
      @if (pendingStop(); as pending) {
        <div id="publication-stop-confirm" class="remove-confirm" role="alertdialog" aria-labelledby="publication-stop-heading">
          <h3 id="publication-stop-heading">Publikation von {{ pending.item.name }} stoppen?</h3>
          <p>Raum {{ session.roomId() }}. Das ist eine Stoppaufforderung an den Zielbrowser, kein ferngesteuertes Capture.</p>
          <label>Quelle
            <select id="publication-stop-source" [ngModel]="pending.source"
              (ngModelChange)="pendingStop.set({ item: pending.item, source: $event })">
              <option value="microphone">Mikrofon</option>
              <option value="camera">Kamera</option>
              <option value="screen">Bildschirm</option>
            </select>
          </label>
          <div class="inline-actions">
            <button id="publication-stop-cancel" type="button" class="button ghost" (click)="pendingStop.set(null)">Abbrechen</button>
            <button id="publication-stop-confirm-action" type="button" class="button primary" (click)="confirmStop()">Stopp anfragen</button>
          </div>
        </div>
      }
      @if (moderation.ownRole() === 'owner' && moderation.audit().length > 0) {
        <ol id="moderation-audit" class="moderation-audit" aria-label="Flüchtiges Moderationsprotokoll">
          @for (entry of moderation.audit(); track entry.sequence) {
            <li [attr.data-action]="entry.action">{{ auditLabel(entry) }}</li>
          }
        </ol>
      }
    </section>
  `,
  styles: [`
    .participant-panel { display: grid; gap: .7rem; }
    .participant-search, .participant-filters label { display: grid; gap: .28rem; color: var(--muted); font-size: .68rem; }
    .participant-filters { display: grid; grid-template-columns: 1fr 1fr; gap: .45rem; }
    .participant-list, .hand-queue { display: grid; gap: .42rem; margin: 0; padding: 0; list-style: none; }
    .hand-queue li, .participant-row { display: flex; align-items: flex-start; justify-content: space-between; gap: .5rem; border: 1px solid var(--line); border-radius: .7rem; padding: .55rem .65rem; background: var(--surface-raised); }
    .participant-row p, .hint { margin: .22rem 0 0; color: var(--muted); font-size: .68rem; }
    .role-chip, .hand-chip, .stage-chip, .pin-chip { display: inline-flex; margin-right: .35rem; border-radius: 999px; padding: .12rem .4rem; font-size: .62rem; font-weight: 720; }
    .role-chip { border: 1px solid rgba(169, 139, 255, .35); color: #d8c9ff; }
    .stage-chip { border: 1px solid rgba(102, 224, 183, .35); color: #c8f8e8; }
    .pin-chip { border: 1px solid rgba(255, 255, 255, .2); color: #d7deea; }
    .hand-chip { border: 1px solid rgba(255, 196, 92, .4); color: var(--amber); }
    .observation[data-kind="local"] { color: #c8f8e8; }
    .observation[data-kind="received"] { color: #d7deea; }
    .participant-actions { display: grid; gap: .28rem; }
    .remove-confirm { display: grid; gap: .45rem; border: 1px solid rgba(255, 119, 125, .3); border-radius: .7rem; padding: .7rem; }
    .remove-confirm h3, .remove-confirm p { margin: 0; }
    .moderation-audit { margin: 0; padding-left: 1.1rem; color: var(--muted); font-size: .68rem; }
  `],
})
export class RoomParticipantListComponent {
  readonly query = signal("");
  readonly roleFilter = signal<ParticipantRoleFilter>("all");
  readonly handFilter = signal<ParticipantHandFilter>("all");
  readonly removeDraft = signal<ParticipantListRow | null>(null);
  readonly localPin = computed(() => this.stage.localPin());
  readonly pendingStop = signal<{ item: ParticipantListRow; source: LocalMediaSource } | null>(null);
  readonly rows = computed(() => participantListRows({
    ownPeerId: this.moderation.ownPeerId() || this.session.peerId(),
    ownName: this.session.displayName(),
    participants: this.moderation.participants(),
    queue: this.moderation.queue(),
    peerNames: this.mesh.peerChoices(),
    localSources: this.media.publications().map((item) => item.source),
    remoteSources: this.mesh.remoteMedia().map((item) => ({ peerId: item.peerId, source: item.source })),
  }));
  readonly visibleRows = computed(() => {
    const query = this.query().trim().toLocaleLowerCase("de-DE");
    const role = this.roleFilter();
    const hand = this.handFilter();
    return this.rows().filter((item) => (
      (role === "all" || item.role === role)
      && (hand === "all" || item.hand === hand)
      && (!query || `${item.name} ${item.peerId}`.toLocaleLowerCase("de-DE").includes(query))
    ));
  });
  readonly queueRows = computed(() => this.rows().filter((item) => item.queuePosition > 0)
    .sort((left, right) => left.queuePosition - right.queuePosition));

  constructor(
    readonly session: RoomSessionService,
    readonly mesh: PeerMeshService,
    readonly media: MediaPublicationService,
    readonly moderation: RoomModerationService,
    readonly stage: PresentationStageService,
  ) {}

  canClear(item: ParticipantListRow): boolean {
    return this.canModerate(item) && item.hand === "raised";
  }

  canRemove(item: ParticipantListRow): boolean {
    return this.canModerate(item);
  }

  askRemove(item: ParticipantListRow): void {
    if (!this.canRemove(item)) return;
    this.removeDraft.set(item);
  }

  confirmRemove(): void {
    const pending = this.removeDraft();
    this.removeDraft.set(null);
    if (!pending || !this.canRemove(pending)) return;
    this.moderation.remove(pending.peerId);
  }

  canAssignPresenter(item: ParticipantListRow): boolean {
    return this.session.mode() !== "pair" && this.moderation.ownRole() === "owner"
      && item.peerId !== this.moderation.presenterPeerId();
  }

  togglePin(peerId: string): void {
    this.stage.togglePin(peerId);
  }

  undoSeconds(expiresAt: number): number {
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  }

  askStop(item: ParticipantListRow): void {
    if (!this.canRemove(item)) return;
    this.pendingStop.set({ item, source: "microphone" });
  }

  confirmStop(): void {
    const pending = this.pendingStop();
    this.pendingStop.set(null);
    if (!pending || !this.canRemove(pending.item)) return;
    this.moderation.requestStop(pending.item.peerId, pending.source);
  }

  auditLabel(entry: ModerationAuditEntry): string {
    const action: Record<ModerationAction, string> = {
      "hand-raise": "Hand gehoben",
      "hand-lower": "Hand gesenkt",
      "hand-clear": "Hand gesenkt (Owner)",
      "peer-remove": "Entfernen geplant",
      "peer-remove-cancel": "Entfernen zurückgenommen",
      "presenter-assign": "Bühne übergeben",
      "publication-stop": `Stoppaufforderung ${mediaObservationLabel(entry.source)}`,
      "whiteboard-policy-set": `Tafel-Modus geändert (${entry.source === "presenter-only" ? "Presenter" : "Offen"})`,
    };
    return `${action[entry.action]} · ${entry.actorPeerId.slice(0, 8)} → ${entry.targetPeerId.slice(0, 8)}`;
  }

  sourceText(sources: readonly string[]): string {
    return sources.map((source) => mediaObservationLabel(source)).join(", ");
  }

  private canModerate(item: ParticipantListRow): boolean {
    return this.session.mode() !== "pair" && this.moderation.ownRole() === "owner" && !item.own;
  }
}
