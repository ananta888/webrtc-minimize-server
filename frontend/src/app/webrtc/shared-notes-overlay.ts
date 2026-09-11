import {
  decodeSharedNotesBytes,
  SharedNotesOperation,
  SharedNotesSnapshotPayload,
  SharedNotesUpdatePayload,
} from "./shared-notes-contract";

export interface SharedNotesDelivery {
  readonly originPeerId: string;
  readonly trafficClass: string;
  readonly data: Uint8Array;
}

export interface SharedNotesState {
  readonly text: string;
  readonly revision: number;
  readonly lastAuthorPeerId: string;
}

export const INITIAL_SHARED_NOTES_STATE: SharedNotesState = Object.freeze({
  text: "",
  revision: 0,
  lastAuthorPeerId: "",
});

export function ingestSharedNotesDelivery(
  delivery: SharedNotesDelivery,
  context: Readonly<{ membershipEpoch: number; knownPeerIds: ReadonlySet<string>; seen: ReadonlySet<string> }>,
): SharedNotesOperation | null {
  if (delivery.trafficClass !== "event") return null;
  // Maximum size bounded to 48 KB (32 KB characters in JSON structure)
  if (delivery.data.byteLength > 48 * 1024) return null;
  const operation = decodeSharedNotesBytes(delivery.data);
  if (!operation) return null;
  if (operation.membershipEpoch !== context.membershipEpoch) return null;
  if (operation.authorPeerId !== delivery.originPeerId) return null;
  if (!context.knownPeerIds.has(operation.authorPeerId)) return null;
  if (context.seen.has(operation.opId)) return null;
  return operation;
}

export function applySharedNotesOperation(
  current: SharedNotesState,
  operation: SharedNotesOperation,
): SharedNotesState {
  if (operation.kind === "notes-sync-request") {
    return current;
  }

  if (operation.kind === "notes-snapshot") {
    const payload = operation.payload as SharedNotesSnapshotPayload;
    if (payload.revision > current.revision) {
      return Object.freeze({
        text: payload.text,
        revision: payload.revision,
        lastAuthorPeerId: operation.authorPeerId,
      });
    }
    if (payload.revision === current.revision && payload.revision > 0) {
      if (operation.authorPeerId > current.lastAuthorPeerId) {
        return Object.freeze({
          text: payload.text,
          revision: payload.revision,
          lastAuthorPeerId: operation.authorPeerId,
        });
      }
    }
    return current;
  }

  if (operation.kind === "notes-update") {
    const payload = operation.payload as SharedNotesUpdatePayload;
    if (payload.revision > current.revision) {
      return Object.freeze({
        text: payload.text,
        revision: payload.revision,
        lastAuthorPeerId: operation.authorPeerId,
      });
    }
    if (payload.revision === current.revision) {
      if (operation.authorPeerId > current.lastAuthorPeerId) {
        return Object.freeze({
          text: payload.text,
          revision: payload.revision,
          lastAuthorPeerId: operation.authorPeerId,
        });
      }
    }
    return current;
  }

  return current;
}

export function shouldRespondToNotesSync(
  ownPeerId: string,
  requesterPeerId: string,
  participants: readonly { peerId: string; role: string }[],
  currentRevision: number,
): boolean {
  if (currentRevision === 0) return false;
  if (ownPeerId === requesterPeerId) return false;
  const owner = participants.find((p) => p.role === "owner");
  if (owner) {
    return owner.peerId === ownPeerId;
  }
  // If no owner found in participants list, peer with lowest peerId with content responds
  const otherPeerIds = participants.map((p) => p.peerId).filter((id) => id !== requesterPeerId).sort();
  return otherPeerIds[0] === ownPeerId;
}

export function exportNotesFile(
  text: string,
  format: "md" | "txt",
  roomCode?: string,
): { readonly filename: string; readonly blob: Blob } {
  const sanitizedRoom = (roomCode ?? "room").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) || "room";
  const filename = `${sanitizedRoom}-notes.${format}`;
  const mimeType = format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8";
  const blob = new Blob([text], { type: mimeType });
  return { filename, blob };
}
