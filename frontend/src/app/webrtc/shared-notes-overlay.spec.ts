import { describe, expect, it } from "vitest";

import { encodeSharedNotesOperation, SharedNotesOperation } from "./shared-notes-contract";
import {
  applySharedNotesOperation,
  exportNotesFile,
  INITIAL_SHARED_NOTES_STATE,
  ingestSharedNotesDelivery,
  shouldRespondToNotesSync,
} from "./shared-notes-overlay";

describe("shared-notes-overlay", () => {
  const alice = "1111111111111111";
  const bob = "2222222222222222";
  const known = new Set([alice, bob]);

  it("ingests valid delivery and rejects unknown peers, epochs, or replay", () => {
    const op: SharedNotesOperation = {
      version: 1,
      type: "notes-op",
      opId: "a".repeat(32),
      membershipEpoch: 1,
      authorPeerId: alice,
      kind: "notes-update",
      payload: { revision: 1, baseRevision: 0, text: "Initial note" },
    };
    const bytes = encodeSharedNotesOperation(op);
    const seen = new Set<string>();

    const ingested = ingestSharedNotesDelivery(
      { originPeerId: alice, trafficClass: "event", data: bytes },
      { membershipEpoch: 1, knownPeerIds: known, seen },
    );
    expect(ingested).toEqual(op);

    // Replay check
    seen.add(op.opId);
    expect(
      ingestSharedNotesDelivery(
        { originPeerId: alice, trafficClass: "event", data: bytes },
        { membershipEpoch: 1, knownPeerIds: known, seen },
      ),
    ).toBeNull();

    // Wrong traffic class
    expect(
      ingestSharedNotesDelivery(
        { originPeerId: alice, trafficClass: "bulk", data: bytes },
        { membershipEpoch: 1, knownPeerIds: known, seen: new Set() },
      ),
    ).toBeNull();

    // Mismatched origin
    expect(
      ingestSharedNotesDelivery(
        { originPeerId: bob, trafficClass: "event", data: bytes },
        { membershipEpoch: 1, knownPeerIds: known, seen: new Set() },
      ),
    ).toBeNull();
  });

  it("converges state on higher revision or deterministic tie-breaker", () => {
    let state = INITIAL_SHARED_NOTES_STATE;

    const op1: SharedNotesOperation = {
      version: 1,
      type: "notes-op",
      opId: "1".repeat(32),
      membershipEpoch: 1,
      authorPeerId: alice,
      kind: "notes-update",
      payload: { revision: 1, baseRevision: 0, text: "First version" },
    };

    state = applySharedNotesOperation(state, op1);
    expect(state.text).toBe("First version");
    expect(state.revision).toBe(1);
    expect(state.lastAuthorPeerId).toBe(alice);

    // Older revision is ignored
    const oldOp: SharedNotesOperation = {
      version: 1,
      type: "notes-op",
      opId: "2".repeat(32),
      membershipEpoch: 1,
      authorPeerId: bob,
      kind: "notes-update",
      payload: { revision: 0, baseRevision: 0, text: "Old version" },
    };
    state = applySharedNotesOperation(state, oldOp);
    expect(state.text).toBe("First version");

    // Equal revision with higher peerId wins tie-break (bob > alice)
    const tieOp: SharedNotesOperation = {
      version: 1,
      type: "notes-op",
      opId: "3".repeat(32),
      membershipEpoch: 1,
      authorPeerId: bob,
      kind: "notes-update",
      payload: { revision: 1, baseRevision: 0, text: "Bob version" },
    };
    state = applySharedNotesOperation(state, tieOp);
    expect(state.text).toBe("Bob version");
    expect(state.lastAuthorPeerId).toBe(bob);
  });

  it("determines sync responder accurately", () => {
    const participants = [
      { peerId: alice, role: "owner" },
      { peerId: bob, role: "participant" },
    ];
    // With 0 revisions, nobody responds
    expect(shouldRespondToNotesSync(alice, bob, participants, 0)).toBe(false);

    // Owner responds if revision > 0
    expect(shouldRespondToNotesSync(alice, bob, participants, 1)).toBe(true);
    // Non-owner does not respond when owner is present
    expect(shouldRespondToNotesSync(bob, "some-new-peer", participants, 1)).toBe(false);
  });

  it("exports markdown and text blobs with sanitized room name", () => {
    const mdExport = exportNotesFile("# Heading\nNotes", "md", "My Room! 123");
    expect(mdExport.filename).toBe("My_Room__123-notes.md");
    expect(mdExport.blob.type).toContain("markdown");

    const txtExport = exportNotesFile("Plain notes", "txt", "");
    expect(txtExport.filename).toBe("room-notes.txt");
    expect(txtExport.blob.type).toContain("plain");
  });
});
