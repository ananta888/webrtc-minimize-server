import assert from "node:assert/strict";
import test from "node:test";

import {
  POLL_CONTRACT,
  PollContractError,
  decodePollBytes,
  encodePollOperation,
  parsePollOperation,
} from "../src/poll-contract.js";

const base = {
  version: 1,
  type: "poll-op",
  opId: "a".repeat(32),
  membershipEpoch: 1,
  authorPeerId: "aaaaaaaaaaaaaaaa",
  kind: "poll-create",
  payload: {
    pollId: "b".repeat(32),
    question: "Sollen wir den Release heute freigeben?",
    options: ["Ja", "Nein", "Enthaltung"],
    anonymous: true,
  },
};

test("poll operations validate closed schema and limits", () => {
  const op = parsePollOperation(base);
  assert.equal(op.kind, "poll-create");
  assert.equal(POLL_CONTRACT.persistence, "ephemeral");
  assert.equal(POLL_CONTRACT.transport, "opaque-overlay-event");
  assert.equal(POLL_CONTRACT.maxQuestionLength, 120);
  assert.equal(POLL_CONTRACT.minOptions, 2);
  assert.equal(POLL_CONTRACT.maxOptions, 6);

  // Extra field rejected
  assert.throws(() => parsePollOperation({ ...base, extra: 123 }),
    (err) => err instanceof PollContractError);

  // Unknown kind rejected
  assert.throws(() => parsePollOperation({ ...base, kind: "poll-delete" }),
    /unknown_poll_kind/);
});

test("poll-create rejects long questions, too few/many options, or control chars", () => {
  // Question too long (> 120 chars)
  assert.throws(() => parsePollOperation({
    ...base,
    payload: { ...base.payload, question: "q".repeat(121) },
  }), /invalid_poll_payload/);

  // Control char in question
  assert.throws(() => parsePollOperation({
    ...base,
    payload: { ...base.payload, question: "Question with \x00 null" },
  }), /invalid_poll_payload/);

  // Less than 2 options
  assert.throws(() => parsePollOperation({
    ...base,
    payload: { ...base.payload, options: ["Nur eine Option"] },
  }), /invalid_poll_payload/);

  // More than 6 options
  assert.throws(() => parsePollOperation({
    ...base,
    payload: { ...base.payload, options: ["1", "2", "3", "4", "5", "6", "7"] },
  }), /invalid_poll_payload/);

  // Option too long (> 60 chars)
  assert.throws(() => parsePollOperation({
    ...base,
    payload: { ...base.payload, options: ["Option 1", "o".repeat(61)] },
  }), /invalid_poll_payload/);
});

test("poll-vote validates optionIndex and pollId", () => {
  const voteOp = parsePollOperation({
    ...base,
    kind: "poll-vote",
    payload: { pollId: "b".repeat(32), optionIndex: 1 },
  });
  assert.equal(voteOp.kind, "poll-vote");
  assert.equal(voteOp.payload.optionIndex, 1);

  // Negative optionIndex fails
  assert.throws(() => parsePollOperation({
    ...base,
    kind: "poll-vote",
    payload: { pollId: "b".repeat(32), optionIndex: -1 },
  }), /invalid_poll_payload/);

  // optionIndex >= 6 fails
  assert.throws(() => parsePollOperation({
    ...base,
    kind: "poll-vote",
    payload: { pollId: "b".repeat(32), optionIndex: 6 },
  }), /invalid_poll_payload/);
});

test("poll-publish and poll-close validate counts array", () => {
  const publishOp = parsePollOperation({
    ...base,
    kind: "poll-publish",
    payload: { pollId: "b".repeat(32), counts: [5, 2, 1], totalVotes: 8 },
  });
  assert.equal(publishOp.kind, "poll-publish");
  assert.equal(publishOp.payload.totalVotes, 8);
  assert.deepEqual(publishOp.payload.counts, [5, 2, 1]);

  const closeOp = parsePollOperation({
    ...base,
    kind: "poll-close",
    payload: { pollId: "b".repeat(32), counts: [5, 2, 1], totalVotes: 8 },
  });
  assert.equal(closeOp.kind, "poll-close");
});

test("poll-sync-request and poll-snapshot work as expected", () => {
  const syncReq = parsePollOperation({
    ...base,
    kind: "poll-sync-request",
    payload: {},
  });
  assert.equal(syncReq.kind, "poll-sync-request");

  const snapshot = parsePollOperation({
    ...base,
    kind: "poll-snapshot",
    payload: {
      status: "active",
      poll: {
        pollId: "b".repeat(32),
        creatorPeerId: "aaaaaaaaaaaaaaaa",
        question: "Active poll?",
        options: ["Yes", "No"],
        anonymous: true,
      },
      counts: [1, 0],
      totalVotes: 1,
    },
  });
  assert.equal(snapshot.kind, "poll-snapshot");
  assert.equal(snapshot.payload.status, "active");
});

test("encode and decode bytes roundtrip preserves data accurately", () => {
  const op = parsePollOperation(base);
  const bytes = encodePollOperation(op);
  const decoded = decodePollBytes(bytes);
  assert.deepEqual(decoded, op);

  assert.equal(decodePollBytes(new Uint8Array([9, 9, 9])), null);
});
