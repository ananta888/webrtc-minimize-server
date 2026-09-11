import { Injectable, computed, effect, signal } from "@angular/core";

import { OverlayDelivery, PeerMeshService } from "./peer-mesh.service";
import { RoomModerationService } from "./room-moderation.service";
import { RoomSessionService } from "./room-session.service";
import { SignalingService, ServerMessage } from "./signaling.service";
import {
  WhiteboardKind,
  WhiteboardOperation,
  encodeWhiteboardOperation,
  parseWhiteboardOperation,
} from "./whiteboard-contract";
import {
  appendWhiteboardOperation,
  boundSyncOps,
  ingestWhiteboardDelivery,
  ownerPeerIds,
  undoOwnWhiteboardOperations,
} from "./whiteboard-overlay";

function opId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

@Injectable({ providedIn: "root" })
export class WhiteboardOverlayService {
  readonly ops = signal<readonly WhiteboardOperation[]>([]);
  readonly canClear = computed(() => this.session.joined() && this.moderation.ownRole() === "owner");
  private lastDelivery = 0;
  private seen = new Set<string>();
  private hasRequestedSync = false;

  constructor(
    private readonly mesh: PeerMeshService,
    private readonly session: RoomSessionService,
    private readonly moderation: RoomModerationService,
    private readonly signaling: SignalingService,
  ) {
    this.signaling.subscribe((message) => this.applyClear(message));
    effect(() => {
      if (!this.session.joined()) {
        this.reset();
        return;
      }
      for (const item of this.mesh.overlayDeliveries()) {
        if (item.id <= this.lastDelivery) continue;
        this.lastDelivery = item.id;
        this.ingest(item);
      }
      if (!this.hasRequestedSync && this.ops().length === 0 && this.mesh.peerChoices().length > 0) {
        this.hasRequestedSync = true;
        this.requestSync();
      }
    });
  }

  ingest(delivery: OverlayDelivery): boolean {
    const known = new Set([this.session.peerId(), ...this.mesh.peerChoices().map((peer) => peer.id)]);
    const operation = ingestWhiteboardDelivery(delivery, {
      membershipEpoch: this.mesh.membershipEpoch(),
      knownPeerIds: known,
      seen: this.seen,
    });
    if (!operation) return false;

    if (operation.kind === "sync-request") {
      this.seen.add(operation.opId);
      if (this.shouldRespondToSync()) {
        const opsToSync = boundSyncOps(this.ops());
        if (opsToSync.length > 0) {
          const responseOp = parseWhiteboardOperation({
            version: 1,
            type: "whiteboard-op",
            opId: opId(),
            membershipEpoch: this.mesh.membershipEpoch(),
            authorPeerId: this.session.peerId(),
            kind: "sync-response",
            payload: { ops: opsToSync },
          });
          if (responseOp) {
            const bytes = encodeWhiteboardOperation(responseOp);
            void this.mesh.sendOverlayData(delivery.originPeerId, bytes, "event");
          }
        }
      }
      return true;
    }

    if (operation.kind === "sync-response") {
      this.seen.add(operation.opId);
      const incomingOps = (operation.payload["ops"] as readonly WhiteboardOperation[]) || [];
      for (const item of incomingOps) {
        if (this.seen.has(item.opId)) continue;
        if (item.kind === "sync-request" || item.kind === "sync-response") continue;
        if (item.kind === "clear" && !ownerPeerIds(this.moderation.participants()).has(item.authorPeerId)) continue;
        this.seen.add(item.opId);
        this.ops.update((items) => appendWhiteboardOperation(items, item));
      }
      return true;
    }

    if (operation.kind === "clear" && !ownerPeerIds(this.moderation.participants()).has(operation.authorPeerId)) {
      return false;
    }
    this.seen.add(operation.opId);
    this.ops.update((items) => appendWhiteboardOperation(items, operation));
    return true;
  }

  publish(kind: WhiteboardKind, payload: WhiteboardOperation["payload"]): boolean {
    if (!this.session.joined() || this.mesh.membershipEpoch() < 1) return false;
    if (kind === "sync-request" || kind === "sync-response") return false;
    if (kind === "clear" && this.moderation.ownRole() !== "owner") return false;
    const operation = parseWhiteboardOperation({
      version: 1, type: "whiteboard-op", opId: opId(), membershipEpoch: this.mesh.membershipEpoch(),
      authorPeerId: this.session.peerId(), kind, payload,
    });
    if (!operation) return false;
    this.seen.add(operation.opId);
    this.ops.update((items) => appendWhiteboardOperation(items, operation));
    const bytes = encodeWhiteboardOperation(operation);
    for (const peer of this.mesh.peerChoices()) {
      if (this.mesh.machineReceive.isMachine(peer.id)) continue;
      void this.mesh.sendOverlayData(peer.id, bytes, "event");
    }
    return true;
  }

  requestSync(): boolean {
    if (!this.session.joined() || this.mesh.membershipEpoch() < 1) return false;
    const operation = parseWhiteboardOperation({
      version: 1,
      type: "whiteboard-op",
      opId: opId(),
      membershipEpoch: this.mesh.membershipEpoch(),
      authorPeerId: this.session.peerId(),
      kind: "sync-request",
      payload: {},
    });
    if (!operation) return false;
    this.seen.add(operation.opId);
    const bytes = encodeWhiteboardOperation(operation);
    for (const peer of this.mesh.peerChoices()) {
      if (this.mesh.machineReceive.isMachine(peer.id)) continue;
      void this.mesh.sendOverlayData(peer.id, bytes, "event");
    }
    return true;
  }

  requestClear(): void {
    if (!this.canClear()) return;
    this.signaling.send({ type: "whiteboard-clear" });
  }

  undoOwn(): void {
    const own = this.session.peerId();
    this.ops.update((items) => undoOwnWhiteboardOperations(items, own));
  }

  reset(): void {
    this.ops.set([]);
    this.seen.clear();
    this.lastDelivery = 0;
    this.hasRequestedSync = false;
  }

  private shouldRespondToSync(): boolean {
    if (this.ops().length === 0) return false;
    if (this.moderation.ownRole() === "owner") return true;
    const owners = ownerPeerIds(this.moderation.participants());
    const hasConnectedOwner = this.mesh.peerChoices().some((p) => owners.has(p.id));
    return !hasConnectedOwner;
  }

  private applyClear(message: ServerMessage): void {
    if (message.type !== "whiteboard-cleared") return;
    if (Object.keys(message).some((field) => !["version", "type", "membershipEpoch", "actorPeerId"].includes(field))) return;
    if (!Number.isSafeInteger(message["membershipEpoch"]) || Number(message["membershipEpoch"]) !== this.mesh.membershipEpoch()) return;
    if (typeof message["actorPeerId"] !== "string" || !ownerPeerIds(this.moderation.participants()).has(message["actorPeerId"])) return;
    this.ops.set([]);
    this.seen.clear();
  }
}

