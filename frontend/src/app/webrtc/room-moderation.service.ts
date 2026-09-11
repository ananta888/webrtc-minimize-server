import { Injectable, Optional, computed, signal } from "@angular/core";

import { LocalMediaSource, MediaPublicationService } from "./media-publication.service";
import { ServerMessage, SignalingService } from "./signaling.service";

export type RoomRole = "owner" | "participant";
export type HandState = "none" | "raised";
export type ModerationAction = "hand-raise" | "hand-lower" | "hand-clear" | "peer-remove" | "peer-remove-cancel"
  | "publication-stop" | "presenter-assign";

export interface ModerationParticipant {
  readonly peerId: string;
  readonly role: RoomRole;
  readonly hand: HandState;
  readonly raisedAt: number;
}

export interface ModerationAuditEntry {
  readonly sequence: number;
  readonly at: number;
  readonly actorPeerId: string;
  readonly action: ModerationAction;
  readonly targetPeerId: string;
  readonly source: "" | LocalMediaSource;
}

const PEER_ID = /^[a-f0-9]{16}$/;
const ACTIONS = new Set<ModerationAction>([
  "hand-raise", "hand-lower", "hand-clear", "peer-remove", "peer-remove-cancel", "publication-stop", "presenter-assign",
]);
const SOURCES = new Set<LocalMediaSource>(["microphone", "camera", "screen"]);

function parseAudit(value: unknown): readonly ModerationAuditEntry[] | null {
  if (!Array.isArray(value) || value.length > 256) return null;
  const entries: ModerationAuditEntry[] = [];
  let last = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some((field) => !["sequence", "at", "actorPeerId", "action", "targetPeerId", "source"].includes(field))) {
      return null;
    }
    if (!Number.isSafeInteger(row["sequence"]) || Number(row["sequence"]) <= last) return null;
    if (!Number.isSafeInteger(row["at"]) || Number(row["at"]) < 0) return null;
    if (typeof row["actorPeerId"] !== "string" || !PEER_ID.test(row["actorPeerId"])) return null;
    if (typeof row["targetPeerId"] !== "string" || !PEER_ID.test(row["targetPeerId"])) return null;
    if (typeof row["action"] !== "string" || !ACTIONS.has(row["action"] as ModerationAction)) return null;
    const action = row["action"] as ModerationAction;
    const source = row["source"];
    if (action === "publication-stop") {
      if (typeof source !== "string" || !SOURCES.has(source as LocalMediaSource)) return null;
    } else if (source !== "") return null;
    last = Number(row["sequence"]);
    entries.push({
      sequence: last,
      at: Number(row["at"]),
      actorPeerId: row["actorPeerId"],
      action,
      targetPeerId: row["targetPeerId"],
      source: action === "publication-stop" ? source as LocalMediaSource : "",
    });
  }
  return Object.freeze(entries);
}

export interface PendingRemove {
  readonly targetPeerId: string;
  readonly expiresAt: number;
}

function parsePendingRemove(value: unknown, participantIds: ReadonlySet<string>): PendingRemove | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((field) => !["targetPeerId", "expiresAt"].includes(field))) return null;
  if (typeof row["targetPeerId"] !== "string" || !PEER_ID.test(row["targetPeerId"]) || !participantIds.has(row["targetPeerId"])) {
    return null;
  }
  if (!Number.isSafeInteger(row["expiresAt"]) || Number(row["expiresAt"]) < 1) return null;
  return { targetPeerId: row["targetPeerId"], expiresAt: Number(row["expiresAt"]) };
}

function parseSnapshot(message: ServerMessage): {
  membershipEpoch: number;
  participants: readonly ModerationParticipant[];
  queue: readonly string[];
  audit: readonly ModerationAuditEntry[];
  presenterPeerId: string;
  pendingRemove: PendingRemove | null;
} | null {
  if (message.type !== "moderation-state") return null;
  if (!Number.isSafeInteger(message["membershipEpoch"]) || Number(message["membershipEpoch"]) < 1) return null;
  if (!Array.isArray(message["participants"]) || !Array.isArray(message["queue"])) return null;
  if (Object.keys(message).some((field) => !["version", "type", "membershipEpoch", "participants", "queue", "audit", "presenterPeerId", "pendingRemove"].includes(field))) {
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
  const audit = Object.hasOwn(message, "audit") ? parseAudit(message["audit"]) : [];
  if (!audit) return null;
  const participantIds = new Set(participants.map((item) => item.peerId));
  let presenterPeerId = "";
  if (Object.hasOwn(message, "presenterPeerId")) {
    if (typeof message["presenterPeerId"] !== "string") return null;
    if (message["presenterPeerId"] !== "" && (!PEER_ID.test(message["presenterPeerId"]) || !participantIds.has(message["presenterPeerId"]))) {
      return null;
    }
    presenterPeerId = message["presenterPeerId"];
  }
  const pending = parsePendingRemove(message["pendingRemove"], participantIds);
  if (pending === null) return null;
  return {
    membershipEpoch: Number(message["membershipEpoch"]),
    participants: Object.freeze(participants),
    queue: Object.freeze([...queue as string[]]),
    audit,
    presenterPeerId,
    pendingRemove: pending || null,
  };
}

function parseStopRequest(message: ServerMessage): { membershipEpoch: number; targetPeerId: string; source: LocalMediaSource } | null {
  if (message.type !== "publication-stop-request") return null;
  if (Object.keys(message).some((field) => !["version", "type", "membershipEpoch", "targetPeerId", "source"].includes(field))) {
    return null;
  }
  if (!Number.isSafeInteger(message["membershipEpoch"]) || Number(message["membershipEpoch"]) < 1) return null;
  if (typeof message["targetPeerId"] !== "string" || !PEER_ID.test(message["targetPeerId"])) return null;
  if (typeof message["source"] !== "string" || !SOURCES.has(message["source"] as LocalMediaSource)) return null;
  return {
    membershipEpoch: Number(message["membershipEpoch"]),
    targetPeerId: message["targetPeerId"],
    source: message["source"] as LocalMediaSource,
  };
}

@Injectable({ providedIn: "root" })
export class RoomModerationService {
  readonly membershipEpoch = signal(0);
  readonly participants = signal<readonly ModerationParticipant[]>([]);
  readonly queue = signal<readonly string[]>([]);
  readonly audit = signal<readonly ModerationAuditEntry[]>([]);
  readonly presenterPeerId = signal("");
  readonly pendingRemove = signal<PendingRemove | null>(null);
  readonly ownPeerId = signal("");
  readonly ownPresenter = computed(() => this.presenterPeerId() !== "" && this.presenterPeerId() === this.ownPeerId());
  readonly ownHand = computed(() => this.participants().find((item) => item.peerId === this.ownPeerId())?.hand === "raised");
  readonly ownRole = computed(() => this.participants().find((item) => item.peerId === this.ownPeerId())?.role || "participant");
  readonly queuePosition = computed(() => {
    const index = this.queue().indexOf(this.ownPeerId());
    return index < 0 ? 0 : index + 1;
  });

  constructor(
    private readonly signaling: SignalingService,
    @Optional() private readonly media: MediaPublicationService | null = null,
  ) {
    this.signaling.subscribe((message) => this.apply(message));
  }

  apply(message: ServerMessage): void {
    const stop = parseStopRequest(message);
    if (stop) {
      if (stop.targetPeerId === this.ownPeerId()) this.media?.stop(stop.source);
      return;
    }
    const snapshot = parseSnapshot(message);
    if (!snapshot) return;
    this.membershipEpoch.set(snapshot.membershipEpoch);
    this.participants.set(snapshot.participants);
    this.queue.set(snapshot.queue);
    this.audit.set(snapshot.audit);
    this.presenterPeerId.set(snapshot.presenterPeerId);
    this.pendingRemove.set(snapshot.pendingRemove);
  }

  bind(peerId: string): void {
    this.ownPeerId.set(peerId);
  }

  reset(): void {
    this.membershipEpoch.set(0);
    this.participants.set([]);
    this.queue.set([]);
    this.audit.set([]);
    this.presenterPeerId.set("");
    this.pendingRemove.set(null);
    this.ownPeerId.set("");
  }

  raise(): void {
    this.signaling.send({ type: this.ownHand() ? "hand-lower" : "hand-raise" });
  }

  clear(targetPeerId: string): void {
    if (this.ownRole() !== "owner") return;
    this.signaling.send({ type: "hand-clear", targetPeerId });
  }

  remove(targetPeerId: string): void {
    if (this.ownRole() !== "owner" || targetPeerId === this.ownPeerId()) return;
    this.signaling.send({ type: "peer-remove", targetPeerId });
  }

  requestStop(targetPeerId: string, source: LocalMediaSource): void {
    if (this.ownRole() !== "owner" || targetPeerId === this.ownPeerId() || !SOURCES.has(source)) return;
    this.signaling.send({ type: "publication-stop", targetPeerId, source });
  }

  assignPresenter(targetPeerId: string): void {
    if (this.ownRole() !== "owner") return;
    this.signaling.send({ type: "presenter-assign", targetPeerId });
  }

  cancelRemove(): void {
    if (this.ownRole() !== "owner" || !this.pendingRemove()) return;
    this.signaling.send({ type: "peer-remove-cancel" });
  }
}
