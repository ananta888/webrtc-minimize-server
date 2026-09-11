import "@angular/compiler";
import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PeerMeshService } from "./peer-mesh.service";
import { decodePollBytes, encodePollOperation } from "./poll-contract";
import { PollService } from "./poll.service";
import { RoomModerationService } from "./room-moderation.service";
import { RoomSessionService } from "./room-session.service";

try {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
} catch {
  // Already initialized
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});

function createService(options?: { ownRole?: string; ownPresenter?: boolean }) {
  const mesh = {
    overlayDeliveries: signal([]),
    membershipEpoch: signal(1),
    peerChoices: signal([{ id: "bbbbbbbbbbbbbbbb", name: "Bob" }]),
    sendOverlayData: vi.fn(async () => true),
    machineReceive: { isMachine: vi.fn(() => false) },
  } as unknown as PeerMeshService;

  const session = {
    joined: signal(true),
    peerId: signal("aaaaaaaaaaaaaaaa"),
    roomId: signal("poll-test-room"),
  } as unknown as RoomSessionService;

  const moderation = {
    ownRole: signal(options?.ownRole ?? "owner"),
    ownPresenter: signal(options?.ownPresenter ?? false),
    participants: signal([
      { peerId: "aaaaaaaaaaaaaaaa", role: options?.ownRole ?? "owner" },
      { peerId: "bbbbbbbbbbbbbbbb", role: "participant" },
    ]),
  } as unknown as RoomModerationService;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: PollService,
        useFactory: () => new PollService(mesh, session, moderation),
      },
    ],
  });

  const service = TestBed.inject(PollService);
  return { service, mesh, session, moderation };
}

describe("PollService", () => {
  it("allows owner/presenter to create poll and broadcasts poll-create", () => {
    const { service, mesh } = createService({ ownRole: "owner" });
    expect(service.canCreatePoll()).toBe(true);

    const ok = service.createPoll("Release heute?", ["Ja", "Nein"]);
    expect(ok).toBe(true);
    expect(service.status()).toBe("active");
    expect(service.poll()?.question).toBe("Release heute?");
    expect(service.counts()).toEqual([0, 0]);
    expect(service.totalVotes()).toBe(0);

    expect(mesh.sendOverlayData).toHaveBeenCalledTimes(1);
    const [destId, bytes, trafficClass] = vi.mocked(mesh.sendOverlayData).mock.calls[0];
    expect(destId).toBe("bbbbbbbbbbbbbbbb");
    expect(trafficClass).toBe("event");

    const decoded = decodePollBytes(bytes);
    expect(decoded?.kind).toBe("poll-create");
  });

  it("denies regular participants from creating polls", () => {
    const { service } = createService({ ownRole: "participant", ownPresenter: false });
    expect(service.canCreatePoll()).toBe(false);
    const ok = service.createPoll("Geheime Frage?", ["A", "B"]);
    expect(ok).toBe(false);
  });

  it("handles incoming vote and prevents duplicate votes", () => {
    const { service } = createService({ ownRole: "owner" });
    service.createPoll("Feature X?", ["Ja", "Nein"]);
    const currentPollId = service.poll()!.pollId;

    const voteOp = {
      version: 1 as const,
      type: "poll-op" as const,
      opId: "c".repeat(32),
      membershipEpoch: 1,
      authorPeerId: "bbbbbbbbbbbbbbbb",
      kind: "poll-vote" as const,
      payload: {
        pollId: currentPollId,
        optionIndex: 0,
      },
    };

    const ingested = service.ingest({
      id: 1,
      originPeerId: "bbbbbbbbbbbbbbbb",
      trafficClass: "event",
      data: encodePollOperation(voteOp),
    });

    expect(ingested).toBe(true);
    expect(service.counts()).toEqual([1, 0]);
    expect(service.totalVotes()).toBe(1);

    // Duplicate vote from Bob ignored
    service.ingest({
      id: 2,
      originPeerId: "bbbbbbbbbbbbbbbb",
      trafficClass: "event",
      data: encodePollOperation({ ...voteOp, opId: "d".repeat(32) }),
    });
    expect(service.counts()).toEqual([1, 0]);
    expect(service.totalVotes()).toBe(1);
  });

  it("publishes results and broadcasts poll-publish to peers", () => {
    const { service, mesh } = createService({ ownRole: "owner" });
    service.createPoll("Feature X?", ["Ja", "Nein"]);
    vi.mocked(mesh.sendOverlayData).mockClear();

    const ok = service.publishResults();
    expect(ok).toBe(true);
    expect(service.status()).toBe("published");

    expect(mesh.sendOverlayData).toHaveBeenCalledTimes(1);
    const [, bytes] = vi.mocked(mesh.sendOverlayData).mock.calls[0];
    const decoded = decodePollBytes(bytes);
    expect(decoded?.kind).toBe("poll-publish");
  });

  it("resets state on leave", () => {
    const { service } = createService({ ownRole: "owner" });
    service.createPoll("Test?", ["A", "B"]);
    expect(service.status()).toBe("active");

    service.reset();
    expect(service.status()).toBe("none");
    expect(service.poll()).toBeNull();
  });
});
