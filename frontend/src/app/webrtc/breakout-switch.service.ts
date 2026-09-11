import { Injectable, computed, signal } from "@angular/core";

import { MediaPublicationService } from "./media-publication.service";
import { RoomModerationService } from "./room-moderation.service";
import { RoomSessionService } from "./room-session.service";
import { ServerMessage, SignalingService } from "./signaling.service";
import {
  BreakoutAssignment, BreakoutSwitchPhase, offerBreakoutSwitch, parseBreakoutAssignment,
} from "./breakout-switch";

@Injectable({ providedIn: "root" })
export class BreakoutSwitchService {
  readonly phase = signal<BreakoutSwitchPhase>("idle");
  readonly assignment = signal<BreakoutAssignment | null>(null);
  readonly setSnapshot = signal<Record<string, unknown> | null>(null);
  readonly parentRoomId = signal<string>("");
  readonly helpNotified = signal<{ childRoomId: string; requesterPeerId: string; requestedAt: number } | null>(null);
  readonly helpAcknowledged = signal<boolean>(false);
  readonly expiresAt = computed(() => Number(this.setSnapshot()?.["expiresAt"] || 0));

  constructor(
    private readonly signaling: SignalingService,
    private readonly session: RoomSessionService,
    private readonly media: MediaPublicationService,
    private readonly moderation: RoomModerationService,
  ) {
    this.signaling.subscribe((message) => this.onMessage(message));
  }

  readonly canOpen = computed(() => this.session.joined() && this.session.mode() === "room"
    && this.moderation.ownRole() === "owner" && this.phase() !== "switching");

  open(childCount = 2, capacity = 10): void {
    if (!this.canOpen) return;
    this.signaling.send({ type: "breakout-open", childCount, capacity });
  }

  assign(targetPeerId: string, childRoomId: string): void {
    if (!this.canOpen) return;
    this.signaling.send({ type: "breakout-assign", targetPeerId, childRoomId });
  }

  assignBalanced(): void {
    if (!this.canOpen) return;
    this.signaling.send({ type: "breakout-assign-balanced" });
  }

  choose(childRoomId: string): void {
    if (!this.session.joined() || this.session.mode() !== "room") return;
    this.signaling.send({ type: "breakout-choose", childRoomId });
  }

  decline(): void {
    this.assignment.set(null);
    if (this.phase() === "offered") this.phase.set("idle");
  }

  requestHelp(): void {
    if (!this.session.joined()) return;
    this.signaling.send({ type: "breakout-help-request" });
  }

  dismissHelp(): void {
    this.helpNotified.set(null);
  }

  async returnToParent(parentRoomId = this.parentRoomId()): Promise<void> {
    if (!this.session.joined() || !parentRoomId) return;
    const name = this.session.displayName();
    this.phase.set("switching");
    try {
      this.media.stopAll();
      await this.session.join(parentRoomId, name, "room");
      this.phase.set("idle");
      this.assignment.set(null);
      this.parentRoomId.set("");
      this.helpAcknowledged.set(false);
    } catch {
      this.media.stopAll();
      this.phase.set("stranded");
    }
  }

  async confirm(): Promise<void> {
    const assignment = this.assignment();
    const name = this.session.displayName();
    if (this.phase() !== "offered" || !assignment || !this.session.joined()) return;
    this.parentRoomId.set(this.session.roomId());
    this.phase.set("switching");
    try {
      this.media.stopAll();
      await this.session.join(assignment.childRoomId, name, "room");
      this.phase.set("idle");
      this.assignment.set(null);
      this.helpAcknowledged.set(false);
    } catch {
      this.media.stopAll();
      this.phase.set("stranded");
    }
  }

  private onMessage(message: ServerMessage): void {
    if (message.type === "breakout-set") {
      this.setSnapshot.set(message);
      return;
    }
    if (message.type === "breakout-revoked") {
      this.assignment.set(null);
      if (this.phase() === "offered") this.phase.set("idle");
      return;
    }
    if (message.type === "breakout-help-notified") {
      this.helpNotified.set({
        childRoomId: String(message["childRoomId"] || ""),
        requesterPeerId: String(message["requesterPeerId"] || ""),
        requestedAt: Number(message["requestedAt"] || 0),
      });
      return;
    }
    if (message.type === "breakout-help-acknowledged") {
      this.helpAcknowledged.set(true);
      return;
    }
    const assignment = parseBreakoutAssignment(message);
    if (!assignment) return;
    this.assignment.set(assignment);
    this.phase.set(offerBreakoutSwitch(this.phase(), assignment, Date.now()));
  }
}
