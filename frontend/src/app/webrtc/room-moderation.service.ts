import { Injectable, computed, signal } from "@angular/core";

import { ServerMessage, SignalingService } from "./signaling.service";

export type RoomRole = "owner" | "participant";
export type HandState = "none" | "raised";

export interface ModerationParticipant {
  readonly peerId: string;
  readonly role: RoomRole;
  readonly hand: HandState;
  readonly raisedAt: number;
}

const PEER_ID = /^[a-f0-9]{16}$/;

function parseSnapshot(message: ServerMessage): {
  membershipEpoch: number;
  participants: readonly ModerationParticipant[];
  queue: readonly string[];
} | null {
  if (message.type !== "moderation-state") return null;
  if (!Number.isSafeInteger(message["membershipEpoch"]) || Number(message["membershipEpoch"]) < 1) return null;
  if (!Array.isArray(message["participants"]) || !Array.isArray(message["queue"])) return null;
  if (Object.keys(message).some((field) => !["version", "type", "membershipEpoch", "participants", "queue"].includes(field))) {
    return null;
  }
  const participants: ModerationParticipant[] = [];
  const seen = new Set<string>();
  for (const item of message["participants"]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (typeof row["peerId"] !== "string" || !PEER_ID.test(row["peerId"]) || seen.has(row["peerId"])) return null;
    if (row["role"] !== "owner" && row["role"] !== "participant") return null;
    if (row["hand"] !== "none" && row["hand"] !== "raised") return null;
    if (!Number.isSafeInteger(row["raisedAt"]) || Number(row["raisedAt"]) < 0) return null;
    if (row["hand"] === "none" && row["raisedAt"] !== 0) return null;
    if (row["hand"] === "raised" && Number(row["raisedAt"]) < 1) return null;
    if (Object.keys(row).some((field) => !["peerId", "role", "hand", "raisedAt"].includes(field))) return null;
    seen.add(row["peerId"]);
    participants.push({
      peerId: row["peerId"],
      role: row["role"],
      hand: row["hand"],
      raisedAt: Number(row["raisedAt"]),
    });
  }
  const raised = new Set(participants.filter((item) => item.hand === "raised").map((item) => item.peerId));
  const queue = message["queue"] as unknown[];
  if (queue.length !== raised.size) return null;
  const queued = new Set<string>();
  for (const peerId of queue) {
    if (typeof peerId !== "string" || !PEER_ID.test(peerId) || !raised.has(peerId) || queued.has(peerId)) return null;
    queued.add(peerId);
  }
  const ordered = [...participants].filter((item) => item.hand === "raised")
    .sort((left, right) => left.raisedAt - right.raisedAt || left.peerId.localeCompare(right.peerId))
    .map((item) => item.peerId);
  if (ordered.some((peerId, index) => queue[index] !== peerId)) return null;
  return {
    membershipEpoch: Number(message["membershipEpoch"]),
    participants: Object.freeze(participants),
    queue: Object.freeze([...queue as string[]]),
  };
}

@Injectable({ providedIn: "root" })
export class RoomModerationService {
  readonly membershipEpoch = signal(0);
  readonly participants = signal<readonly ModerationParticipant[]>([]);
  readonly queue = signal<readonly string[]>([]);
  readonly ownPeerId = signal("");
  readonly ownHand = computed(() => this.participants().find((item) => item.peerId === this.ownPeerId())?.hand === "raised");
  readonly ownRole = computed(() => this.participants().find((item) => item.peerId === this.ownPeerId())?.role || "participant");
  readonly queuePosition = computed(() => {
    const index = this.queue().indexOf(this.ownPeerId());
    return index < 0 ? 0 : index + 1;
  });

  constructor(private readonly signaling: SignalingService) {
    this.signaling.subscribe((message) => this.apply(message));
  }

  apply(message: ServerMessage): void {
    const snapshot = parseSnapshot(message);
    if (!snapshot) return;
    this.membershipEpoch.set(snapshot.membershipEpoch);
    this.participants.set(snapshot.participants);
    this.queue.set(snapshot.queue);
  }

  bind(peerId: string): void {
    this.ownPeerId.set(peerId);
  }

  reset(): void {
    this.membershipEpoch.set(0);
    this.participants.set([]);
    this.queue.set([]);
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
