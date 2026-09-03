import { Injectable, signal } from "@angular/core";

import {
  BroadcastBrowserPortError,
  BroadcastProgramRef,
  BroadcastRoomPublicationSnapshot,
  BroadcastRoomSourceRef,
} from "./broadcast-ports";

const ROOM_ID = /^[a-z0-9][a-z0-9-]{5,47}$/;
const SOURCE_ID = /^src_[A-Za-z0-9_-]{16,64}$/;
const SUBJECT_REF = /^sub_[A-Za-z0-9_-]{16,64}$/;
const SESSION_INSTANCE = /^[A-Za-z0-9_-]{16,128}$/;
const SOURCE_KINDS = new Set(["microphone", "camera", "screen", "screen-audio"]);

@Injectable()
export class BroadcastSourceSelectionService {
  readonly selected = signal<readonly BroadcastRoomSourceRef[]>([]);
  private sessionInstanceId = "";

  select(
    program: BroadcastProgramRef,
    snapshot: BroadcastRoomPublicationSnapshot,
    sourceIds: readonly string[],
  ): readonly BroadcastRoomSourceRef[] {
    if (!snapshot || snapshot.snapshotVersion !== 1 || snapshot.roomId !== program.roomId
      || !ROOM_ID.test(snapshot.roomId) || !ROOM_ID.test(program.roomId)
      || !SESSION_INSTANCE.test(snapshot.sessionInstanceId)
      || !Number.isSafeInteger(snapshot.publicationRevision) || snapshot.publicationRevision < 1
      || !Array.isArray(snapshot.sources) || snapshot.sources.length > 20
      || !Array.isArray(sourceIds) || sourceIds.length < 1 || sourceIds.length > 20) {
      throw new BroadcastBrowserPortError("invalid_broadcast_room_publication_snapshot");
    }
    const byId = new Map<string, BroadcastRoomSourceRef>();
    for (const source of snapshot.sources) {
      if (!source || !SOURCE_ID.test(source.sourceId) || !SUBJECT_REF.test(source.ownerSubjectRef)
        || !SOURCE_KINDS.has(source.kind) || typeof source.local !== "boolean"
        || typeof source.active !== "boolean" || byId.has(source.sourceId)) {
        throw new BroadcastBrowserPortError("invalid_broadcast_room_publication_snapshot");
      }
      byId.set(source.sourceId, source);
    }
    if (new Set(sourceIds).size !== sourceIds.length
      || sourceIds.some((sourceId) => !SOURCE_ID.test(sourceId) || !byId.get(sourceId)?.active)) {
      throw new BroadcastBrowserPortError("invalid_broadcast_source_selection");
    }
    const selected = sourceIds.map((sourceId) => Object.freeze({ ...byId.get(sourceId)! }));
    this.sessionInstanceId = snapshot.sessionInstanceId;
    this.selected.set(Object.freeze(selected));
    return this.selected();
  }

  publicationRevision(snapshot: BroadcastRoomPublicationSnapshot): number {
    if (snapshot.sessionInstanceId !== this.sessionInstanceId || this.selected().length === 0) {
      throw new BroadcastBrowserPortError("stale_broadcast_source_selection");
    }
    return snapshot.publicationRevision;
  }

  clear(): void {
    this.sessionInstanceId = "";
    this.selected.set(Object.freeze([]));
  }
}
