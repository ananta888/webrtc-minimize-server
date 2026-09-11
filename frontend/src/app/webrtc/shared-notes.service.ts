import { Injectable, computed, effect, signal } from "@angular/core";

import { OverlayDelivery, PeerMeshService } from "./peer-mesh.service";
import { RoomModerationService } from "./room-moderation.service";
import { RoomSessionService } from "./room-session.service";
import {
  encodeSharedNotesOperation,
  MAX_NOTES_TEXT_LENGTH,
  parseSharedNotesOperation,
  SharedNotesOperation,
} from "./shared-notes-contract";
import {
  applySharedNotesOperation,
  exportNotesFile,
  INITIAL_SHARED_NOTES_STATE,
  ingestSharedNotesDelivery,
  shouldRespondToNotesSync,
} from "./shared-notes-overlay";

function opId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

@Injectable({ providedIn: "root" })
export class SharedNotesService {
  readonly text = signal<string>("");
  readonly revision = signal<number>(0);
  readonly lastAuthorPeerId = signal<string>("");
  readonly charCount = computed(() => this.text().length);
  readonly maxCharCount = MAX_NOTES_TEXT_LENGTH;
  readonly isOverLimit = computed(() => this.charCount() > this.maxCharCount);

  private lastDelivery = 0;
  private seen = new Set<string>();
  private hasRequestedSync = false;

  constructor(
    private readonly mesh: PeerMeshService,
    private readonly session: RoomSessionService,
    private readonly moderation: RoomModerationService,
  ) {
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
      if (!this.hasRequestedSync && this.revision() === 0 && this.mesh.peerChoices().length > 0) {
        this.hasRequestedSync = true;
        this.requestSync();
      }
    });
  }

  ingest(delivery: OverlayDelivery): boolean {
    const known = new Set([this.session.peerId(), ...this.mesh.peerChoices().map((peer) => peer.id)]);
    const operation = ingestSharedNotesDelivery(delivery, {
      membershipEpoch: this.mesh.membershipEpoch(),
      knownPeerIds: known,
      seen: this.seen,
    });
    if (!operation) return false;

    this.seen.add(operation.opId);

    if (operation.kind === "notes-sync-request") {
      if (
        shouldRespondToNotesSync(
          this.session.peerId(),
          delivery.originPeerId,
          this.moderation.participants(),
          this.revision(),
        )
      ) {
        const responseOp = parseSharedNotesOperation({
          version: 1,
          type: "notes-op",
          opId: opId(),
          membershipEpoch: this.mesh.membershipEpoch(),
          authorPeerId: this.session.peerId(),
          kind: "notes-snapshot",
          payload: {
            revision: this.revision(),
            text: this.text(),
          },
        });
        if (responseOp) {
          const bytes = encodeSharedNotesOperation(responseOp);
          void this.mesh.sendOverlayData(delivery.originPeerId, bytes, "event");
        }
      }
      return true;
    }

    if (operation.kind === "notes-snapshot" || operation.kind === "notes-update") {
      const currentState = {
        text: this.text(),
        revision: this.revision(),
        lastAuthorPeerId: this.lastAuthorPeerId(),
      };
      const nextState = applySharedNotesOperation(currentState, operation);
      if (nextState !== currentState) {
        this.text.set(nextState.text);
        this.revision.set(nextState.revision);
        this.lastAuthorPeerId.set(nextState.lastAuthorPeerId);
      }
      return true;
    }

    return false;
  }

  updateText(newText: string): boolean {
    if (!this.session.joined() || this.mesh.membershipEpoch() < 1) return false;
    if (newText.length > this.maxCharCount) return false;
    if (newText === this.text()) return true;

    const nextRevision = this.revision() + 1;
    const operation = parseSharedNotesOperation({
      version: 1,
      type: "notes-op",
      opId: opId(),
      membershipEpoch: this.mesh.membershipEpoch(),
      authorPeerId: this.session.peerId(),
      kind: "notes-update",
      payload: {
        revision: nextRevision,
        baseRevision: this.revision(),
        text: newText,
      },
    });
    if (!operation) return false;

    this.seen.add(operation.opId);
    this.text.set(newText);
    this.revision.set(nextRevision);
    this.lastAuthorPeerId.set(this.session.peerId());

    const bytes = encodeSharedNotesOperation(operation);
    for (const peer of this.mesh.peerChoices()) {
      if (this.mesh.machineReceive.isMachine(peer.id)) continue;
      void this.mesh.sendOverlayData(peer.id, bytes, "event");
    }
    return true;
  }

  clearNotes(): boolean {
    return this.updateText("");
  }

  requestSync(): boolean {
    if (!this.session.joined() || this.mesh.membershipEpoch() < 1) return false;
    const operation = parseSharedNotesOperation({
      version: 1,
      type: "notes-op",
      opId: opId(),
      membershipEpoch: this.mesh.membershipEpoch(),
      authorPeerId: this.session.peerId(),
      kind: "notes-sync-request",
      payload: {},
    });
    if (!operation) return false;

    this.seen.add(operation.opId);
    const bytes = encodeSharedNotesOperation(operation);
    for (const peer of this.mesh.peerChoices()) {
      if (this.mesh.machineReceive.isMachine(peer.id)) continue;
      void this.mesh.sendOverlayData(peer.id, bytes, "event");
    }
    return true;
  }

  export(format: "md" | "txt"): void {
    const { filename, blob } = exportNotesFile(this.text(), format, this.session.roomId());
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  reset(): void {
    this.text.set(INITIAL_SHARED_NOTES_STATE.text);
    this.revision.set(INITIAL_SHARED_NOTES_STATE.revision);
    this.lastAuthorPeerId.set(INITIAL_SHARED_NOTES_STATE.lastAuthorPeerId);
    this.seen.clear();
    this.lastDelivery = 0;
    this.hasRequestedSync = false;
  }
}
