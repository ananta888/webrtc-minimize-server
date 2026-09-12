import { Injectable, OnDestroy, computed, effect, signal } from "@angular/core";

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
  authorizedClearPeerIds,
  authorizedDrawerPeerIds,
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
export class WhiteboardOverlayService implements OnDestroy {
  readonly ops = signal<readonly WhiteboardOperation[]>([]);
  readonly remoteLasers = signal<ReadonlyMap<string, { x: number; y: number; updatedAt: number }>>(new Map());
  readonly canClear = computed(() => {
    if (!this.session.joined()) return true;
    return this.moderation.ownRole() === "owner" || this.moderation.ownPresenter();
  });
  readonly canDraw = computed(() => {
    if (!this.session.joined()) return true;
    if (this.moderation.whiteboardPolicy() === "open") return true;
    return this.moderation.ownRole() === "owner" || this.moderation.ownPresenter();
  });
  private lastDelivery = 0;
  private seen = new Set<string>();
  private hasRequestedSync = false;
  private wasJoined = false;
  private lastLaserSent = 0;
  private laserTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly mesh: PeerMeshService,
    private readonly session: RoomSessionService,
    private readonly moderation: RoomModerationService,
    private readonly signaling: SignalingService,
  ) {
    this.signaling.subscribe((message) => this.applyClear(message));
    this.laserTimer = setInterval(() => this.pruneOldLasers(), 500);
    effect(() => {
      const joined = this.session.joined();
      if (!joined) {
        if (this.wasJoined) {
          this.wasJoined = false;
          this.reset();
        }
        return;
      }
      this.wasJoined = true;
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

    const policy = this.moderation.whiteboardPolicy();
    const authorized = authorizedDrawerPeerIds(
      this.moderation.participants(),
      this.moderation.presenterPeerId(),
      policy,
      known,
    );
    const authorizedClear = authorizedClearPeerIds(
      this.moderation.participants(),
      this.moderation.presenterPeerId(),
    );

    if (operation.kind === "laser") {
      if (!authorized.has(operation.authorPeerId)) return false;
      const pt = operation.payload["point"] as { x: number; y: number } | undefined;
      if (pt && typeof pt.x === "number" && typeof pt.y === "number") {
        this.updateRemoteLaser(operation.authorPeerId, pt);
      }
      return true;
    }

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
        if (item.kind === "clear" && !authorizedClear.has(item.authorPeerId)) continue;
        if (item.kind !== "clear" && !authorized.has(item.authorPeerId)) continue;
        this.seen.add(item.opId);
        this.ops.update((items) => appendWhiteboardOperation(items, item));
      }
      return true;
    }

    if (operation.kind === "clear" && !authorizedClear.has(operation.authorPeerId)) {
      return false;
    }
    if (operation.kind !== "clear" && !authorized.has(operation.authorPeerId)) {
      return false;
    }
    this.seen.add(operation.opId);
    this.ops.update((items) => appendWhiteboardOperation(items, operation));
    return true;
  }

  publish(kind: WhiteboardKind, payload: WhiteboardOperation["payload"]): boolean {
    if (kind === "sync-request" || kind === "sync-response") return false;
    if (kind === "clear") {
      if (!this.canClear()) return false;
    } else {
      if (!this.canDraw()) return false;
    }
    const epoch = Math.max(1, this.mesh.membershipEpoch());
    const authorPeerId = this.session.peerId() || "0123456789abcdef";
    const operation = parseWhiteboardOperation({
      version: 1, type: "whiteboard-op", opId: opId(), membershipEpoch: epoch,
      authorPeerId, kind, payload,
    });
    if (!operation) return false;
    this.seen.add(operation.opId);
    this.ops.update((items) => appendWhiteboardOperation(items, operation));
    if (this.session.joined()) {
      const bytes = encodeWhiteboardOperation(operation);
      for (const peer of this.mesh.peerChoices()) {
        if (this.mesh.machineReceive.isMachine(peer.id)) continue;
        void this.mesh.sendOverlayData(peer.id, bytes, "event");
      }
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
    if (this.session.joined() && this.mesh.peerChoices().length > 0) {
      this.signaling.send({ type: "whiteboard-clear" });
    } else {
      this.ops.set([]);
      this.seen.clear();
    }
  }

  undoOwn(): void {
    const own = this.session.peerId() || "0123456789abcdef";
    this.ops.update((items) => undoOwnWhiteboardOperations(items, own));
  }

  sendLaser(point: { x: number; y: number }): void {
    if (!this.canDraw()) return;
    const now = Date.now();
    if (now - this.lastLaserSent < 40) return;
    this.lastLaserSent = now;
    if (this.session.joined()) {
      const epoch = Math.max(1, this.mesh.membershipEpoch());
      const authorPeerId = this.session.peerId() || "0123456789abcdef";
      const op = parseWhiteboardOperation({
        version: 1,
        type: "whiteboard-op",
        opId: opId(),
        membershipEpoch: epoch,
        authorPeerId,
        kind: "laser",
        payload: { point },
      });
      if (op) {
        const bytes = encodeWhiteboardOperation(op);
        for (const peer of this.mesh.peerChoices()) {
          if (this.mesh.machineReceive.isMachine(peer.id)) continue;
          void this.mesh.sendOverlayData(peer.id, bytes, "event");
        }
      }
    }
  }

  updateRemoteLaser(peerId: string, point: { x: number; y: number }): void {
    const next = new Map(this.remoteLasers());
    next.set(peerId, { ...point, updatedAt: Date.now() });
    this.remoteLasers.set(next);
  }

  pruneOldLasers(): void {
    const now = Date.now();
    const current = this.remoteLasers();
    if (current.size === 0) return;
    let changed = false;
    const next = new Map<string, { x: number; y: number; updatedAt: number }>();
    for (const [peerId, laser] of current.entries()) {
      if (now - laser.updatedAt <= 2500) {
        next.set(peerId, laser);
      } else {
        changed = true;
      }
    }
    if (changed) this.remoteLasers.set(next);
  }

  ngOnDestroy(): void {
    if (this.laserTimer) {
      clearInterval(this.laserTimer);
      this.laserTimer = null;
    }
    this.remoteLasers.set(new Map());
  }

  reset(): void {
    this.ops.set([]);
    this.remoteLasers.set(new Map());
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
    if (typeof message["actorPeerId"] !== "string" || !authorizedClearPeerIds(this.moderation.participants(), this.moderation.presenterPeerId()).has(message["actorPeerId"])) return;
    this.ops.set([]);
    this.seen.clear();
  }
}

