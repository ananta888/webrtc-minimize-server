import { describe, expect, it } from "vitest";

import {
  decodePollBytes,
  encodePollOperation,
  parsePollOperation,
  POLL_CONSTANTS,
  PollOperation,
} from "./poll-contract";

describe("poll-contract (frontend)", () => {
  const baseOp: PollOperation = {
    version: 1,
    type: "poll-op",
    opId: "a".repeat(32),
    membershipEpoch: 1,
    authorPeerId: "1234567890abcdef",
    kind: "poll-create",
    payload: {
      pollId: "b".repeat(32),
      question: "Welcher Termin passt am besten?",
      options: ["Montag 10:00", "Dienstag 14:00", "Mittwoch 16:00"],
      anonymous: true,
    },
  };

  it("parses valid poll-create operation and constants", () => {
    const parsed = parsePollOperation(baseOp);
    expect(parsed).toEqual(baseOp);
    expect(POLL_CONSTANTS.maxQuestionLength).toBe(120);
    expect(POLL_CONSTANTS.minOptions).toBe(2);
    expect(POLL_CONSTANTS.maxOptions).toBe(6);
    expect(POLL_CONSTANTS.maxOptionLength).toBe(60);
    expect(POLL_CONSTANTS.trafficClass).toBe("event");
  });

  it("fails closed on invalid kinds or missing fields", () => {
    expect(parsePollOperation({ ...baseOp, kind: "unknown" })).toBeNull();
    expect(parsePollOperation({ ...baseOp, version: 2 })).toBeNull();
    expect(parsePollOperation({ ...baseOp, authorPeerId: "invalid" })).toBeNull();
    expect(parsePollOperation({ ...baseOp, extra: "extra" })).toBeNull();
  });

  it("validates question length and option limits", () => {
    expect(parsePollOperation({
      ...baseOp,
      payload: { ...baseOp.payload, question: "x".repeat(121) },
    })).toBeNull();

    expect(parsePollOperation({
      ...baseOp,
      payload: { ...baseOp.payload, options: ["Nur eine"] },
    })).toBeNull();

    expect(parsePollOperation({
      ...baseOp,
      payload: { ...baseOp.payload, options: ["1", "2", "3", "4", "5", "6", "7"] },
    })).toBeNull();
  });

  it("parses poll-vote, poll-publish, poll-close and poll-snapshot", () => {
    const vote = parsePollOperation({
      ...baseOp,
      kind: "poll-vote",
      payload: { pollId: "b".repeat(32), optionIndex: 2 },
    });
    expect(vote?.kind).toBe("poll-vote");

    const publish = parsePollOperation({
      ...baseOp,
      kind: "poll-publish",
      payload: { pollId: "b".repeat(32), counts: [2, 1, 0], totalVotes: 3 },
    });
    expect(publish?.kind).toBe("poll-publish");

    const snapshot = parsePollOperation({
      ...baseOp,
      kind: "poll-snapshot",
      payload: {
        status: "active",
        poll: {
          pollId: "b".repeat(32),
          creatorPeerId: "1234567890abcdef",
          question: "Question?",
          options: ["A", "B"],
          anonymous: true,
        },
        counts: [1, 0],
        totalVotes: 1,
      },
    });
    expect(snapshot?.kind).toBe("poll-snapshot");
  });

  it("encodes and decodes bytes accurately", () => {
    const bytes = encodePollOperation(baseOp);
    const decoded = decodePollBytes(bytes);
    expect(decoded).toEqual(baseOp);

    expect(decodePollBytes(new Uint8Array([0, 1]))).toBeNull();
  });
});
