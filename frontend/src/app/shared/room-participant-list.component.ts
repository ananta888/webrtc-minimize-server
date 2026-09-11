import { ChangeDetectionStrategy, Component, computed, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";

import { MediaPublicationService } from "../webrtc/media-publication.service";
import { PeerMeshService } from "../webrtc/peer-mesh.service";
import { RoomModerationService } from "../webrtc/room-moderation.service";
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
              @if (canRemove(item)) {
                <button type="button" class="button ghost compact" [attr.data-remove-peer]="item.peerId"
                  (click)="askRemove(item)">Entfernen…</button>
              }
            </div>
          </li>
        } @empty {
          <li class="list-empty">{{ session.joined() ? 'Keine Treffer in der aktuellen Filterung.' : 'Noch keinem Raum beigetreten.' }}</li>
        }
      </ul>
      @if (pendingRemove(); as pending) {
        <div id="peer-remove-confirm" class="remove-confirm" role="alertdialog" aria-labelledby="peer-remove-heading">
          <h3 id="peer-remove-heading">{{ pending.name }} entfernen?</h3>
          <p>Raum {{ session.roomId() }}. Die Person verliert die Membership in dieser Instanz. Capture startet nicht.</p>
          <div class="inline-actions">
            <button id="peer-remove-cancel" type="button" class="button ghost" (click)="pendingRemove.set(null)">Abbrechen</button>
            <button id="peer-remove-confirm-action" type="button" class="button primary" (click)="confirmRemove()">Entfernen</button>
          </div>
        </div>
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
    .role-chip, .hand-chip { display: inline-flex; margin-right: .35rem; border-radius: 999px; padding: .12rem .4rem; font-size: .62rem; font-weight: 720; }
    .role-chip { border: 1px solid rgba(169, 139, 255, .35); color: #d8c9ff; }
    .hand-chip { border: 1px solid rgba(255, 196, 92, .4); color: var(--amber); }
    .observation[data-kind="local"] { color: #c8f8e8; }
    .observation[data-kind="received"] { color: #d7deea; }
    .participant-actions { display: grid; gap: .28rem; }
    .remove-confirm { display: grid; gap: .45rem; border: 1px solid rgba(255, 119, 125, .3); border-radius: .7rem; padding: .7rem; }
    .remove-confirm h3, .remove-confirm p { margin: 0; }
  `],
})
export class RoomParticipantListComponent {
  readonly query = signal("");
  readonly roleFilter = signal<ParticipantRoleFilter>("all");
  readonly handFilter = signal<ParticipantHandFilter>("all");
  readonly pendingRemove = signal<ParticipantListRow | null>(null);
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
  ) {}

  canClear(item: ParticipantListRow): boolean {
    return this.canModerate(item) && item.hand === "raised";
  }

  canRemove(item: ParticipantListRow): boolean {
    return this.canModerate(item);
  }

  askRemove(item: ParticipantListRow): void {
    if (!this.canRemove(item)) return;
    this.pendingRemove.set(item);
  }

  confirmRemove(): void {
    const pending = this.pendingRemove();
    this.pendingRemove.set(null);
    if (!pending || !this.canRemove(pending)) return;
    this.moderation.remove(pending.peerId);
  }

  sourceText(sources: readonly string[]): string {
    return sources.map((source) => mediaObservationLabel(source)).join(", ");
  }

  private canModerate(item: ParticipantListRow): boolean {
    return this.session.mode() !== "pair" && this.moderation.ownRole() === "owner" && !item.own;
  }
}
