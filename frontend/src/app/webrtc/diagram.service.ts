import { Injectable, OnDestroy, computed, effect, signal } from "@angular/core";

import { DiagramOperation, DiagramTool, encodeDiagramOperation, parseDiagramOperation } from "./diagram-contract";
import {
  DiagramDoc,
  DiagramLockEntry,
  DiagramToolState,
  applyDiagramLock,
  authorizedDiagramEditorPeerIds,
  diagramDocFromOperation,
  diagramToolStateFromOperation,
  ingestDiagramDelivery,
  pruneDiagramLocks,
  winsDiagramLww,
} from "./diagram-overlay";
import { OverlayDelivery, PeerMeshService } from "./peer-mesh.service";
import { RoomModerationService } from "./room-moderation.service";
import { RoomSessionService } from "./room-session.service";

const PUBLISH_DEBOUNCE_MS = 800;
const LOCK_PRUNE_INTERVAL_MS = 5_000;

function opId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

@Injectable({ providedIn: "root" })
export class DiagramService implements OnDestroy {
  readonly docs = signal<ReadonlyMap<DiagramTool, DiagramDoc>>(new Map());
  readonly toolState = signal<DiagramToolState | null>(null);
  readonly locks = signal<ReadonlyMap<string, DiagramLockEntry>>(new Map());
  readonly activeTool = computed<DiagramTool>(() => this.toolState()?.tool || "bpmn");
  readonly canEdit = computed(() => {
    if (!this.session.joined()) return true;
    if (this.moderation.diagramPolicy() === "open") return true;
    return this.moderation.ownRole() === "owner" || this.moderation.ownPresenter();
  });

  private lastDelivery = 0;
  private seen = new Set<string>();
  private hasRequestedSync = false;
  private wasJoined = false;
  private pendingSnapshot: { tool: DiagramTool; xml: string } | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly mesh: PeerMeshService,
    private readonly session: RoomSessionService,
    private readonly moderation: RoomModerationService,
  ) {
    this.pruneTimer = setInterval(() => this.pruneLocks(), LOCK_PRUNE_INTERVAL_MS);
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
      if (!this.hasRequestedSync && this.docs().size === 0 && this.mesh.peerChoices().length > 0) {
        this.hasRequestedSync = true;
        this.requestSync();
      }
    });
  }

  doc(tool: DiagramTool = this.activeTool()): DiagramDoc | null {
    return this.docs().get(tool) || null;
  }

  ingest(delivery: OverlayDelivery): boolean {
    if (this.mesh.machineReceive.isMachine(delivery.originPeerId)) return false;
    const known = new Set([this.session.peerId(), ...this.mesh.peerChoices().map((peer) => peer.id)]);
    const operation = ingestDiagramDelivery(delivery, {
      membershipEpoch: this.mesh.membershipEpoch(),
      knownPeerIds: known,
      seen: this.seen,
    });
    if (!operation) return false;
    this.seen.add(operation.opId);

    if (operation.kind === "sync-request") {
      this.respondToSync(delivery.originPeerId);
      return true;
    }
    const authorized = authorizedDiagramEditorPeerIds(
      this.moderation.participants(),
      this.moderation.presenterPeerId(),
      this.moderation.diagramPolicy(),
      known,
    );
    if (operation.kind === "sync-response") {
      if (!authorized.has(operation.authorPeerId)) return false;
      this.applyOperation(operation);
      return true;
    }
    if (!authorized.has(operation.authorPeerId)) return false;
    this.applyOperation(operation);
    return true;
  }

  publishSnapshot(tool: DiagramTool, xml: string): boolean {
    if (!this.canEdit()) return false;
    const revision = (this.docs().get(tool)?.revision ?? 0) + 1;
    return Boolean(this.emit("snapshot", { tool, xml, revision }, "bulk"));
  }

  scheduleSnapshot(tool: DiagramTool, xml: string): void {
    if (!this.canEdit()) return;
    this.pendingSnapshot = { tool, xml };
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      const pending = this.pendingSnapshot;
      this.pendingSnapshot = null;
      if (pending) this.publishSnapshot(pending.tool, pending.xml);
    }, PUBLISH_DEBOUNCE_MS);
  }

  flushSnapshot(): void {
    if (!this.publishTimer) return;
    clearTimeout(this.publishTimer);
    this.publishTimer = null;
    const pending = this.pendingSnapshot;
    this.pendingSnapshot = null;
    if (pending) this.publishSnapshot(pending.tool, pending.xml);
  }

  setTool(tool: DiagramTool): boolean {
    if (!this.canEdit()) return false;
    const revision = (this.toolState()?.revision ?? 0) + 1;
    return Boolean(this.emit("tool", { tool, revision }, "event"));
  }

  setLock(elementId: string, locked: boolean): boolean {
    if (!this.canEdit()) return false;
    return Boolean(this.emit("lock", { elementId, locked }, "event"));
  }

  requestSync(): boolean {
    if (!this.session.joined() || this.mesh.membershipEpoch() < 1) return false;
    return Boolean(this.emit("sync-request", {}, "event"));
  }

  ngOnDestroy(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.publishTimer = null;
    this.pruneTimer = null;
    this.reset();
  }

  reset(): void {
    this.docs.set(new Map());
    this.toolState.set(null);
    this.locks.set(new Map());
    this.seen.clear();
    this.lastDelivery = 0;
    this.hasRequestedSync = false;
    this.pendingSnapshot = null;
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
  }

  private emit(
    kind: DiagramOperation["kind"],
    payload: Readonly<Record<string, unknown>>,
    trafficClass: "event" | "bulk",
  ): DiagramOperation | null {
    const operation = parseDiagramOperation({
      version: 1,
      type: "diagram-op",
      opId: opId(),
      membershipEpoch: Math.max(1, this.mesh.membershipEpoch()),
      authorPeerId: this.session.peerId() || "0123456789abcdef",
      kind,
      payload,
    });
    if (!operation) return null;
    this.seen.add(operation.opId);
    this.applyOperation(operation);
    if (this.session.joined()) this.fanout(operation, trafficClass);
    return operation;
  }

  private applyOperation(operation: DiagramOperation): void {
    if (operation.kind === "snapshot" || operation.kind === "sync-response") {
      const doc = diagramDocFromOperation(operation);
      if (!doc) return;
      this.docs.update((docs) => {
        if (!winsDiagramLww(docs.get(doc.tool), doc)) return docs;
        const next = new Map(docs);
        next.set(doc.tool, doc);
        return next;
      });
      return;
    }
    if (operation.kind === "tool") {
      const state = diagramToolStateFromOperation(operation);
      if (!state) return;
      this.toolState.update((current) => winsDiagramLww(current, state) ? state : current);
      return;
    }
    if (operation.kind === "lock") {
      this.locks.update((locks) => applyDiagramLock(locks, operation, Date.now()));
    }
  }

  private fanout(operation: DiagramOperation, trafficClass: "event" | "bulk"): void {
    const bytes = encodeDiagramOperation(operation);
    for (const peer of this.mesh.peerChoices()) {
      if (this.mesh.machineReceive.isMachine(peer.id)) continue;
      void this.mesh.sendOverlayData(peer.id, bytes, trafficClass);
    }
  }

  private respondToSync(originPeerId: string): void {
    if (!this.shouldRespondToSync()) return;
    const state = this.toolState();
    const doc = this.docs().get(state?.tool || "bpmn");
    if (!doc) return;
    const authorPeerId = this.session.peerId() || "0123456789abcdef";
    const epoch = Math.max(1, this.mesh.membershipEpoch());
    if (state) {
      const toolOp = parseDiagramOperation({
        version: 1, type: "diagram-op", opId: opId(), membershipEpoch: epoch,
        authorPeerId, kind: "tool", payload: { tool: state.tool, revision: state.revision },
      });
      if (toolOp) {
        this.seen.add(toolOp.opId);
        void this.mesh.sendOverlayData(originPeerId, encodeDiagramOperation(toolOp), "event");
      }
    }
    const response = parseDiagramOperation({
      version: 1, type: "diagram-op", opId: opId(), membershipEpoch: epoch,
      authorPeerId, kind: "sync-response",
      payload: { tool: doc.tool, xml: doc.xml, revision: doc.revision, docAuthor: doc.authorPeerId },
    });
    if (!response) return;
    this.seen.add(response.opId);
    void this.mesh.sendOverlayData(originPeerId, encodeDiagramOperation(response), "bulk");
  }

  private shouldRespondToSync(): boolean {
    if (this.moderation.ownRole() === "owner") return true;
    const owners = new Set(this.moderation.participants()
      .filter((item) => item.role === "owner")
      .map((item) => item.peerId));
    return !this.mesh.peerChoices().some((peer) => owners.has(peer.id));
  }

  private pruneLocks(): void {
    this.locks.update((locks) => pruneDiagramLocks(locks, Date.now()));
  }
}
