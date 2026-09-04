import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";

import {
  BroadcastModerationConfirmationView,
  BroadcastModerationDraft,
} from "./broadcast-moderation-workflow";

export interface BroadcastModerationSourceView {
  readonly sourceId: string;
  readonly subjectRef: string;
  readonly ownerLabel: string;
  readonly sourceLabel: string;
  readonly kind: "microphone" | "camera" | "screen" | "screen-audio";
  readonly state: "requested" | "selected" | "active" | "ended" | "revoked";
  readonly consentState: "not-required" | "pending" | "active" | "missing-or-expired";
  readonly ownedByCurrentUser: boolean;
}

export interface BroadcastModerationPackagerView {
  readonly agentId: string;
  readonly label: string;
  readonly online: boolean;
  readonly eligible: boolean;
  readonly healthLabel: string;
  readonly uploadLabel: string;
  readonly energyLabel: string;
}

@Component({
  selector: "app-broadcast-moderation-panel",
  standalone: true,
  templateUrl: "./broadcast-moderation-panel.component.html",
  styleUrl: "./broadcast-moderation-panel.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BroadcastModerationPanelComponent {
  readonly connected = input(false);
  readonly live = input(false);
  readonly actorRole = input<"owner" | "moderator" | "presenter" | "packager" | "viewer">("viewer");
  readonly sources = input<readonly BroadcastModerationSourceView[]>([]);
  readonly packagers = input<readonly BroadcastModerationPackagerView[]>([]);
  readonly activePackagerId = input("");
  readonly confirmation = input<BroadcastModerationConfirmationView | null>(null);
  readonly conflictCode = input<string | null>(null);
  readonly busy = input(false);
  readonly requestAction = output<BroadcastModerationDraft>();
  readonly confirmAction = output<string>();
  readonly cancelAction = output<void>();
  readonly layout = signal<BroadcastModerationDraft["layout"]>("single");
  readonly primaryAgentId = signal("");
  readonly standbyAgentIds = signal<readonly string[]>([]);
  readonly canModerate = computed(() => this.actorRole() === "owner" || this.actorRole() === "moderator");

  requestSource(source: BroadcastModerationSourceView): void {
    if (!this.available() || !this.canModerate()) return;
    this.requestAction.emit({
      action: "source-request",
      targetLabel: `${source.ownerLabel} · ${source.sourceLabel}`,
      targetSubjectRef: source.subjectRef,
      sourceKind: source.kind,
    });
  }

  removeSource(source: BroadcastModerationSourceView): void {
    if (!this.available() || (!source.ownedByCurrentUser && !this.canModerate())) return;
    this.requestAction.emit({
      action: source.ownedByCurrentUser ? "own-source-revoke" : "source-remove",
      targetLabel: `${source.ownerLabel} · ${source.sourceLabel}`,
      targetSubjectRef: source.subjectRef,
      sourceId: source.sourceId,
      reasonCode: source.ownedByCurrentUser ? "PUBLISHER_REVOKED" : "MODERATOR_REMOVED",
    });
  }

  requestLayout(): void {
    if (!this.available() || !this.canModerate() || !this.layout()) return;
    this.requestAction.emit({ action: "layout-change", targetLabel: this.layout()!, layout: this.layout() });
  }

  selectPrimary(agentId: string): void {
    if (!this.packagers().some((agent) => agent.agentId === agentId && agent.online && agent.eligible)) return;
    this.primaryAgentId.set(agentId);
    this.standbyAgentIds.update((ids) => Object.freeze(ids.filter((id) => id !== agentId)));
  }

  toggleStandby(agentId: string, selected: boolean): void {
    if (agentId === this.primaryAgentId()) return;
    const next = new Set(this.standbyAgentIds());
    if (selected && next.size < 2) next.add(agentId);
    if (!selected) next.delete(agentId);
    this.standbyAgentIds.set(Object.freeze([...next].sort()));
  }

  requestPackagerSelection(): void {
    if (!this.available() || !this.canModerate() || !this.primaryAgentId()) return;
    this.requestAction.emit({
      action: "packager-select",
      targetLabel: this.packagerLabel(this.primaryAgentId()),
      primaryAgentId: this.primaryAgentId(),
      standbyAgentIds: this.standbyAgentIds(),
    });
  }

  requestHandoff(agentId: string): void {
    if (!this.available() || !this.canModerate() || agentId === this.activePackagerId()) return;
    this.requestAction.emit({
      action: "packager-handoff",
      targetLabel: this.packagerLabel(agentId),
      primaryAgentId: agentId,
    });
  }

  requestStop(): void {
    if (!this.available() || !this.canModerate()) return;
    this.requestAction.emit({
      action: "program-stop",
      targetLabel: "Laufende Sendung",
      reasonCode: "MODERATOR_STOP",
    });
  }

  confirm(id: string): void { if (!this.busy()) this.confirmAction.emit(id); }

  cancel(): void { if (!this.busy()) this.cancelAction.emit(); }

  isStandby(agentId: string): boolean { return this.standbyAgentIds().includes(agentId); }

  standbyLimitReached(): boolean { return this.standbyAgentIds().length >= 2; }

  private available(): boolean { return this.connected() && !this.busy(); }

  private packagerLabel(agentId: string): string {
    return this.packagers().find((agent) => agent.agentId === agentId)?.label || agentId;
  }
}
