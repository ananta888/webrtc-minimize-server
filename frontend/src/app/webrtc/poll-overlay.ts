import {
  decodePollBytes,
  PollClosePayload,
  PollCreatePayload,
  PollDefinition,
  PollOperation,
  PollPublishPayload,
  PollSnapshotPayload,
  PollVotePayload,
} from "./poll-contract";

export interface PollDelivery {
  readonly originPeerId: string;
  readonly trafficClass: string;
  readonly data: Uint8Array;
}

export type PollStatus = "none" | "active" | "published" | "closed";

export interface ActivePollState {
  readonly status: PollStatus;
  readonly poll: PollDefinition | null;
  readonly counts: readonly number[];
  readonly totalVotes: number;
  readonly ownVotedIndex: number | null;
  readonly votesByPeer: ReadonlyMap<string, number>;
}

export const INITIAL_POLL_STATE: ActivePollState = Object.freeze({
  status: "none",
  poll: null,
  counts: Object.freeze([]),
  totalVotes: 0,
  ownVotedIndex: null,
  votesByPeer: new Map(),
});

export function ingestPollDelivery(
  delivery: PollDelivery,
  context: Readonly<{ membershipEpoch: number; knownPeerIds: ReadonlySet<string>; seen: ReadonlySet<string> }>,
): PollOperation | null {
  if (delivery.trafficClass !== "event") return null;
  if (delivery.data.byteLength > 16 * 1024) return null;
  const operation = decodePollBytes(delivery.data);
  if (!operation) return null;
  if (operation.membershipEpoch !== context.membershipEpoch) return null;
  if (operation.authorPeerId !== delivery.originPeerId) return null;
  if (!context.knownPeerIds.has(operation.authorPeerId)) return null;
  if (context.seen.has(operation.opId)) return null;
  return operation;
}

export function applyPollCreate(
  current: ActivePollState,
  operation: PollOperation,
): ActivePollState {
  const payload = operation.payload as PollCreatePayload;
  const poll: PollDefinition = {
    pollId: payload.pollId,
    creatorPeerId: operation.authorPeerId,
    question: payload.question,
    options: payload.options,
    anonymous: payload.anonymous,
  };
  const counts = Object.freeze(new Array(payload.options.length).fill(0));
  return Object.freeze({
    status: "active",
    poll,
    counts,
    totalVotes: 0,
    ownVotedIndex: null,
    votesByPeer: new Map(),
  });
}

export function applyPollVote(
  current: ActivePollState,
  operation: PollOperation,
  ownPeerId: string,
): ActivePollState {
  if (current.status !== "active" || !current.poll) return current;
  const payload = operation.payload as PollVotePayload;
  if (payload.pollId !== current.poll.pollId) return current;
  if (payload.optionIndex < 0 || payload.optionIndex >= current.poll.options.length) return current;

  // Track own voted index if author is self
  const ownVotedIndex = operation.authorPeerId === ownPeerId ? payload.optionIndex : current.ownVotedIndex;

  // Only the poll creator aggregates votes
  if (current.poll.creatorPeerId !== ownPeerId) {
    return Object.freeze({
      ...current,
      ownVotedIndex,
    });
  }

  // Creator aggregation: reject duplicate votes from the same peer
  if (current.votesByPeer.has(operation.authorPeerId)) {
    return current;
  }

  const nextVotes = new Map(current.votesByPeer);
  nextVotes.set(operation.authorPeerId, payload.optionIndex);

  const nextCounts = [...current.counts];
  nextCounts[payload.optionIndex] = (nextCounts[payload.optionIndex] || 0) + 1;

  return Object.freeze({
    ...current,
    counts: Object.freeze(nextCounts),
    totalVotes: current.totalVotes + 1,
    ownVotedIndex,
    votesByPeer: nextVotes,
  });
}

export function applyPollPublish(
  current: ActivePollState,
  operation: PollOperation,
): ActivePollState {
  if (!current.poll) return current;
  const payload = operation.payload as PollPublishPayload;
  if (payload.pollId !== current.poll.pollId) return current;

  return Object.freeze({
    ...current,
    status: "published",
    counts: payload.counts,
    totalVotes: payload.totalVotes,
  });
}

export function applyPollClose(
  current: ActivePollState,
  operation: PollOperation,
): ActivePollState {
  if (!current.poll) return current;
  const payload = operation.payload as PollClosePayload;
  if (payload.pollId !== current.poll.pollId) return current;

  return Object.freeze({
    ...current,
    status: "closed",
    counts: payload.counts,
    totalVotes: payload.totalVotes,
  });
}

export function applyPollSnapshot(
  current: ActivePollState,
  operation: PollOperation,
): ActivePollState {
  const payload = operation.payload as PollSnapshotPayload;
  if (payload.status === "none" || !payload.poll) {
    return current;
  }
  return Object.freeze({
    status: payload.status,
    poll: payload.poll,
    counts: payload.counts,
    totalVotes: payload.totalVotes,
    ownVotedIndex: current.ownVotedIndex,
    votesByPeer: current.votesByPeer,
  });
}

export function exportPollResults(
  poll: PollDefinition,
  counts: readonly number[],
  totalVotes: number,
  roomCode?: string,
): { readonly filename: string; readonly content: string; readonly blob: Blob } {
  const sanitizedRoom = (roomCode ?? "room").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) || "room";
  const filename = `${sanitizedRoom}-poll-${poll.pollId.slice(0, 8)}.txt`;

  const lines: string[] = [
    `Umfrage-Ergebnis: ${poll.question}`,
    `Gesamtstimmen: ${totalVotes}`,
    "--------------------------------------------------",
  ];

  for (let i = 0; i < poll.options.length; i++) {
    const count = counts[i] || 0;
    const percent = totalVotes > 0 ? ((count / totalVotes) * 100).toFixed(1) : "0.0";
    lines.push(`[${i + 1}] ${poll.options[i]}: ${count} Stimmen (${percent}%)`);
  }

  lines.push("--------------------------------------------------");
  lines.push(`Erstellt am: ${new Date().toISOString()}`);

  const content = lines.join("\n");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  return { filename, content, blob };
}
