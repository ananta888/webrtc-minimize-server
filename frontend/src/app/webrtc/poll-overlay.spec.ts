import { describe, expect, it } from "vitest";

import { encodePollOperation, PollOperation } from "./poll-contract";
import {
  applyPollClose,
  applyPollCreate,
  applyPollPublish,
  applyPollVote,
  exportPollResults,
  INITIAL_POLL_STATE,
  ingestPollDelivery,
} from "./poll-overlay";

describe("poll-overlay", () => {
  const alice = "1111111111111111"; // Creator / Moderator
  const bob = "2222222222222222";   // Voter 1
  const carol = "3333333333333333"; // Voter 2
  const known = new Set([alice, bob, carol]);
  const pollId = "a".repeat(32);

  const createOp: PollOperation = {
    version: 1,
    type: "poll-op",
    opId: "1".repeat(32),
    membershipEpoch: 1,
    authorPeerId: alice,
    kind: "poll-create",
    payload: {
      pollId,
      question: "Meeting verlängern?",
      options: ["Ja", "Nein"],
      anonymous: true,
    },
  };

  it("ingests poll deliveries, validates epochs and rejects replays", () => {
    const bytes = encodePollOperation(createOp);
    const seen = new Set<string>();

    const ingested = ingestPollDelivery(
      { originPeerId: alice, trafficClass: "event", data: bytes },
      { membershipEpoch: 1, knownPeerIds: known, seen },
    );
    expect(ingested).toEqual(createOp);

    seen.add(createOp.opId);
    expect(
      ingestPollDelivery(
        { originPeerId: alice, trafficClass: "event", data: bytes },
        { membershipEpoch: 1, knownPeerIds: known, seen },
      ),
    ).toBeNull();
  });

  it("applies poll create, tracks single vote per peer and prevents duplicate votes", () => {
    let state = applyPollCreate(INITIAL_POLL_STATE, createOp);
    expect(state.status).toBe("active");
    expect(state.poll?.question).toBe("Meeting verlängern?");
    expect(state.counts).toEqual([0, 0]);
    expect(state.totalVotes).toBe(0);

    // Bob votes for option 0 ("Ja")
    const bobVote: PollOperation = {
      version: 1,
      type: "poll-op",
      opId: "2".repeat(32),
      membershipEpoch: 1,
      authorPeerId: bob,
      kind: "poll-vote",
      payload: { pollId, optionIndex: 0 },
    };

    state = applyPollVote(state, bobVote, alice);
    expect(state.counts).toEqual([1, 0]);
    expect(state.totalVotes).toBe(1);

    // Bob tries to vote again -> ignored!
    state = applyPollVote(state, bobVote, alice);
    expect(state.counts).toEqual([1, 0]);
    expect(state.totalVotes).toBe(1);

    // Carol votes for option 1 ("Nein")
    const carolVote: PollOperation = {
      version: 1,
      type: "poll-op",
      opId: "3".repeat(32),
      membershipEpoch: 1,
      authorPeerId: carol,
      kind: "poll-vote",
      payload: { pollId, optionIndex: 1 },
    };

    state = applyPollVote(state, carolVote, alice);
    expect(state.counts).toEqual([1, 1]);
    expect(state.totalVotes).toBe(2);
  });

  it("publishes results and closes poll deterministically", () => {
    let state = applyPollCreate(INITIAL_POLL_STATE, createOp);

    const publishOp: PollOperation = {
      version: 1,
      type: "poll-op",
      opId: "4".repeat(32),
      membershipEpoch: 1,
      authorPeerId: alice,
      kind: "poll-publish",
      payload: { pollId, counts: [3, 1], totalVotes: 4 },
    };

    state = applyPollPublish(state, publishOp);
    expect(state.status).toBe("published");
    expect(state.counts).toEqual([3, 1]);
    expect(state.totalVotes).toBe(4);

    const closeOp: PollOperation = {
      version: 1,
      type: "poll-op",
      opId: "5".repeat(32),
      membershipEpoch: 1,
      authorPeerId: alice,
      kind: "poll-close",
      payload: { pollId, counts: [3, 1], totalVotes: 4 },
    };

    state = applyPollClose(state, closeOp);
    expect(state.status).toBe("closed");
  });

  it("exports poll results as formatted text", () => {
    const { filename, content, blob } = exportPollResults(
      {
        pollId,
        creatorPeerId: alice,
        question: "Verlängern?",
        options: ["Ja", "Nein"],
        anonymous: true,
      },
      [3, 1],
      4,
      "Room 42",
    );

    expect(filename).toBe(`Room_42-poll-${pollId.slice(0, 8)}.txt`);
    expect(blob.type).toContain("plain");
    expect(content).toContain("Umfrage-Ergebnis: Verlängern?");
    expect(content).toContain("Gesamtstimmen: 4");
    expect(content).toContain("[1] Ja: 3 Stimmen (75.0%)");
    expect(content).toContain("[2] Nein: 1 Stimmen (25.0%)");
  });
});
