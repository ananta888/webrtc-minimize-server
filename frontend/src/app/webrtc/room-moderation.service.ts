import { Injectable, computed, signal } from "@angular/core";

import { ServerMessage, SignalingService } from "./signaling.service";

export type RoomRole = "owner" | "participant";
export type HandState = "none" | "raised";

export interface ModerationParticipant {
  readonly peerId: string;
  readonly role: RoomRole;
  readonly hand: HandState;
}

function parseSnapshot(message: ServerMessage): { membershipEpoch: number; participants: readonly ModerationParticipant[] } | null {
  if (message.type !== "moderation-state") return null;
  if (!Number.isSafeInteger(message["membershipEpoch"]) || Number(message["membershipEpoch"]) < 1) return null;
  if (!Array.isArray(message["participants"])) return null;
  const participants: ModerationParticipant[] = [];
  for (const item of message["participants"]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (typeof row["peerId"] !== "string" || !/^[a-f0-9]{16}$/.test(row["peerId"])) return null;
    if (row["role"] !== "owner" && row["role"] !== "participant") return null;
    if (row["hand"] !== "none" && row["hand"] !== "raised") return null;
    if (Object.keys(row).some((field) => !["peerId", "role", "hand"].includes(field))) return null;
    participants.push({ peerId: row["peerId"], role: row["role"], hand: row["hand"] });
  }
  return { membershipEpoch: Number(message["membershipEpoch"]), participants: Object.freeze(participants) };
}

@Injectable({ providedIn: "root" })
export class RoomModerationService {
  readonly membershipEpoch = signal(0);
  readonly participants = signal<readonly ModerationParticipant[]>([]);
  readonly ownPeerId = signal("");
  readonly ownHand = computed(() => this.participants().find((item) => item.peerId === this.ownPeerId())?.hand === "raised");
  readonly ownRole = computed(() => this.participants().find((item) => item.peerId === this.ownPeerId())?.role || "participant");

  constructor(private readonly signaling: SignalingService) {
    this.signaling.subscribe((message) => this.apply(message));
  }

  apply(message: ServerMessage): void {
    const snapshot = parseSnapshot(message);
    if (!snapshot) return;
    this.membershipEpoch.set(snapshot.membershipEpoch);
    this.participants.set(snapshot.participants);
  }

  bind(peerId: string): void {
    this.ownPeerId.set(peerId);
  }

  reset(): void {
    this.membershipEpoch.set(0);
    this.participants.set([]);
    this.ownPeerId.set("");
  }

  raise(): void {
    this.signaling.send({ type: this.ownHand() ? "hand-lower" : "hand-raise" });
  }

  clear(targetPeerId: string): void {
    if (this.ownRole() !== "owner") return;
    this.signaling.send({ type: "hand-clear", targetPeerId });
  }
}
