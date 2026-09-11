import { Injectable, computed, effect, signal } from "@angular/core";

import { OverlayDelivery, PeerMeshService } from "./peer-mesh.service";
import { RoomModerationService } from "./room-moderation.service";
import { RoomSessionService } from "./room-session.service";
import {
  encodePollOperation,
  parsePollOperation,
  POLL_CONSTANTS,
  PollDefinition,
  PollOperation,
} from "./poll-contract";
import {
  ActivePollState,
  applyPollClose,
  applyPollCreate,
  applyPollPublish,
  applyPollSnapshot,
  applyPollVote,
  exportPollResults,
  INITIAL_POLL_STATE,
  ingestPollDelivery,
  PollStatus,
} from "./poll-overlay";

function opId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

@Injectable({ providedIn: "root" })
export class PollService {
  readonly status = signal<PollStatus>("none");
  readonly poll = signal<PollDefinition | null>(null);
  readonly counts = signal<readonly number[]>([]);
  readonly totalVotes = signal<number>(0);
  readonly ownVotedIndex = signal<number | null>(null);

  readonly canCreatePoll = computed(() => {
    return this.session.joined() && (this.moderation.ownRole() === "owner" || this.moderation.ownPresenter());
  });

  readonly isCreator = computed(() => {
    const currentPoll = this.poll();
    return Boolean(currentPoll && currentPoll.creatorPeerId === this.session.peerId());
  });

  readonly hasVoted = computed(() => this.ownVotedIndex() !== null);

  private lastDelivery = 0;
  private seen = new Set<string>();
  private votesByPeer = new Map<string, number>();

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
      if (this.status() === "none" && this.mesh.peerChoices().length > 0 && !this.seen.has("sync-requested")) {
        this.seen.add("sync-requested");
        this.requestSync();
      }
    });
  }

  ingest(delivery: OverlayDelivery): boolean {
    const known = new Set([this.session.peerId(), ...this.mesh.peerChoices().map((peer) => peer.id)]);
    const operation = ingestPollDelivery(delivery, {
      membershipEpoch: this.mesh.membershipEpoch(),
      knownPeerIds: known,
      seen: this.seen,
    });
    if (!operation) return false;

    this.seen.add(operation.opId);

    if (operation.kind === "poll-sync-request") {
      if (this.status() !== "none" && (this.isCreator() || this.moderation.ownRole() === "owner")) {
        const responseOp = parsePollOperation({
          version: 1,
          type: "poll-op",
          opId: opId(),
          membershipEpoch: this.mesh.membershipEpoch(),
          authorPeerId: this.session.peerId(),
          kind: "poll-snapshot",
          payload: {
            status: this.status(),
            poll: this.poll(),
            counts: [...this.counts()],
            totalVotes: this.totalVotes(),
          },
        });
        if (responseOp) {
          const bytes = encodePollOperation(responseOp);
          void this.mesh.sendOverlayData(delivery.originPeerId, bytes, "event");
        }
      }
      return true;
    }

    if (operation.kind === "poll-create") {
      const next = applyPollCreate(this.toState(), operation);
      this.fromState(next);
      return true;
    }

    if (operation.kind === "poll-vote") {
      const next = applyPollVote(this.toState(), operation, this.session.peerId());
      this.fromState(next);
      return true;
    }

    if (operation.kind === "poll-publish") {
      const next = applyPollPublish(this.toState(), operation);
      this.fromState(next);
      return true;
    }

    if (operation.kind === "poll-close") {
      const next = applyPollClose(this.toState(), operation);
      this.fromState(next);
      return true;
    }

    if (operation.kind === "poll-snapshot") {
      const next = applyPollSnapshot(this.toState(), operation);
      this.fromState(next);
      return true;
    }

    return false;
  }

  createPoll(question: string, options: readonly string[], anonymous = true): boolean {
    if (!this.canCreatePoll() || this.mesh.membershipEpoch() < 1) return false;
    if (options.length < POLL_CONSTANTS.minOptions || options.length > POLL_CONSTANTS.maxOptions) return false;

    const pollId = opId();
    const operation = parsePollOperation({
      version: 1,
      type: "poll-op",
      opId: opId(),
      membershipEpoch: this.mesh.membershipEpoch(),
      authorPeerId: this.session.peerId(),
      kind: "poll-create",
      payload: {
        pollId,
        question,
        options,
        anonymous,
      },
    });
    if (!operation) return false;

    this.seen.add(operation.opId);
    const next = applyPollCreate(this.toState(), operation);
    this.fromState(next);

    const bytes = encodePollOperation(operation);
    for (const peer of this.mesh.peerChoices()) {
      if (this.mesh.machineReceive.isMachine(peer.id)) continue;
      void this.mesh.sendOverlayData(peer.id, bytes, "event");
    }
    return true;
  }

  vote(optionIndex: number): boolean {
    const currentPoll = this.poll();
    if (!this.session.joined() || this.status() !== "active" || !currentPoll || this.hasVoted()) return false;
    if (optionIndex < 0 || optionIndex >= currentPoll.options.length) return false;

    const operation = parsePollOperation({
      version: 1,
      type: "poll-op",
      opId: opId(),
      membershipEpoch: this.mesh.membershipEpoch(),
      authorPeerId: this.session.peerId(),
      kind: "poll-vote",
      payload: {
        pollId: currentPoll.pollId,
        optionIndex,
      },
    });
    if (!operation) return false;

    this.seen.add(operation.opId);
    this.ownVotedIndex.set(optionIndex);

    const bytes = encodePollOperation(operation);
    if (this.isCreator()) {
      const next = applyPollVote(this.toState(), operation, this.session.peerId());
      this.fromState(next);
    } else {
      void this.mesh.sendOverlayData(currentPoll.creatorPeerId, bytes, "event");
    }
    return true;
  }

  publishResults(): boolean {
    const currentPoll = this.poll();
    if (!this.session.joined() || !currentPoll || !this.isCreator()) return false;

    const operation = parsePollOperation({
      version: 1,
      type: "poll-op",
      opId: opId(),
      membershipEpoch: this.mesh.membershipEpoch(),
      authorPeerId: this.session.peerId(),
      kind: "poll-publish",
      payload: {
        pollId: currentPoll.pollId,
        counts: [...this.counts()],
        totalVotes: this.totalVotes(),
      },
    });
    if (!operation) return false;

    this.seen.add(operation.opId);
    const next = applyPollPublish(this.toState(), operation);
    this.fromState(next);

    const bytes = encodePollOperation(operation);
    for (const peer of this.mesh.peerChoices()) {
      if (this.mesh.machineReceive.isMachine(peer.id)) continue;
      void this.mesh.sendOverlayData(peer.id, bytes, "event");
    }
    return true;
  }

  closePoll(): boolean {
    const currentPoll = this.poll();
    if (!this.session.joined() || !currentPoll || (!this.isCreator() && !this.canCreatePoll())) return false;

    const operation = parsePollOperation({
      version: 1,
      type: "poll-op",
      opId: opId(),
      membershipEpoch: this.mesh.membershipEpoch(),
      authorPeerId: this.session.peerId(),
      kind: "poll-close",
      payload: {
        pollId: currentPoll.pollId,
        counts: [...this.counts()],
        totalVotes: this.totalVotes(),
      },
    });
    if (!operation) return false;

    this.seen.add(operation.opId);
    const next = applyPollClose(this.toState(), operation);
    this.fromState(next);

    const bytes = encodePollOperation(operation);
    for (const peer of this.mesh.peerChoices()) {
      if (this.mesh.machineReceive.isMachine(peer.id)) continue;
      void this.mesh.sendOverlayData(peer.id, bytes, "event");
    }
    return true;
  }

  requestSync(): boolean {
    if (!this.session.joined() || this.mesh.membershipEpoch() < 1) return false;
    const operation = parsePollOperation({
      version: 1,
      type: "poll-op",
      opId: opId(),
      membershipEpoch: this.mesh.membershipEpoch(),
      authorPeerId: this.session.peerId(),
      kind: "poll-sync-request",
      payload: {},
    });
    if (!operation) return false;

    this.seen.add(operation.opId);
    const bytes = encodePollOperation(operation);
    for (const peer of this.mesh.peerChoices()) {
      if (this.mesh.machineReceive.isMachine(peer.id)) continue;
      void this.mesh.sendOverlayData(peer.id, bytes, "event");
    }
    return true;
  }

  exportResults(): void {
    const currentPoll = this.poll();
    if (!currentPoll) return;
    const { filename, blob } = exportPollResults(currentPoll, this.counts(), this.totalVotes(), this.session.roomId());
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
    this.status.set(INITIAL_POLL_STATE.status);
    this.poll.set(INITIAL_POLL_STATE.poll);
    this.counts.set(INITIAL_POLL_STATE.counts);
    this.totalVotes.set(INITIAL_POLL_STATE.totalVotes);
    this.ownVotedIndex.set(INITIAL_POLL_STATE.ownVotedIndex);
    this.votesByPeer.clear();
    this.seen.clear();
    this.lastDelivery = 0;
  }

  private toState(): ActivePollState {
    return {
      status: this.status(),
      poll: this.poll(),
      counts: this.counts(),
      totalVotes: this.totalVotes(),
      ownVotedIndex: this.ownVotedIndex(),
      votesByPeer: this.votesByPeer,
    };
  }

  private fromState(state: ActivePollState): void {
    this.status.set(state.status);
    this.poll.set(state.poll);
    this.counts.set(state.counts);
    this.totalVotes.set(state.totalVotes);
    this.ownVotedIndex.set(state.ownVotedIndex);
    this.votesByPeer = new Map(state.votesByPeer);
  }
}
