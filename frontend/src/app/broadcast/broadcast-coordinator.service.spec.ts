import { describe, expect, it, vi } from "vitest";

import { BroadcastCoordinatorService } from "./broadcast-coordinator.service";
import { BroadcastDeliveryCapabilityService } from "./broadcast-delivery-capability.service";
import {
  BroadcastCaptureForkPort,
  BroadcastCompositionPort,
  BroadcastConsentPort,
  BroadcastPublicationPort,
  BroadcastStartPlan,
  BroadcastStatsPort,
} from "./broadcast-ports";
import { BroadcastProgramStateService } from "./broadcast-program-state.service";
import { BroadcastSourceSelectionService } from "./broadcast-source-selection.service";
import { BroadcastVideoDirectionPort, BroadcastVideoDirectionView } from "./broadcast-video-direction";

const SOURCE_A = "src_aaaaaaaaaaaaaaaa";
const SOURCE_B = "src_bbbbbbbbbbbbbbbb";

function plan(overrides: Partial<BroadcastStartPlan> = {}): BroadcastStartPlan {
  return {
    planVersion: 1,
    trigger: "user-action",
    program: {
      tenantId: "tn_aaaaaaaaaaaaaaaa",
      roomId: "room-alpha",
      programId: "prg_aaaaaaaaaaaaaaaa",
      programRevision: 4,
      programEpoch: 7,
    },
    roomPublication: {
      snapshotVersion: 1,
      sessionInstanceId: "session_aaaaaaaaaaaaaaaa",
      roomId: "room-alpha",
      publicationRevision: 9,
      sources: [
        {
          sourceId: SOURCE_A,
          ownerSubjectRef: "sub_aaaaaaaaaaaaaaaa",
          kind: "camera",
          local: true,
          active: true,
        },
        {
          sourceId: SOURCE_B,
          ownerSubjectRef: "sub_bbbbbbbbbbbbbbbb",
          kind: "screen",
          local: false,
          active: true,
        },
      ],
    },
    sourceIds: [SOURCE_A, SOURCE_B],
    adapterId: "mock-publisher",
    ...overrides,
  };
}

function fixture(options: {
  failPublication?: boolean;
  failStopOnce?: boolean;
  consent?: BroadcastConsentPort;
  direction?: BroadcastVideoDirectionPort;
} = {}) {
  const events: string[] = [];
  let failPublication = options.failPublication === true;
  let failStop = options.failStopOnce === true;
  let statsListener: ((sample: {
    sampledAt: number;
    outboundBitsPerSecond: number;
    inboundBitsPerSecond: number;
    droppedFrames: number;
  }) => void) | null = null;
  const consent: BroadcastConsentPort = options.consent || {
    async authorize(program, sources, signal) {
      events.push("consent");
      signal.throwIfAborted();
      return {
        decisionVersion: 1,
        programEpoch: program.programEpoch,
        sourceIds: sources.map(({ sourceId }) => sourceId),
        expiresAt: Number.MAX_SAFE_INTEGER,
      };
    },
  };
  const capture: BroadcastCaptureForkPort = {
    async fork(_program, source, publicationRevision, signal) {
      events.push(`fork:${source.sourceId}:${publicationRevision}`);
      signal.throwIfAborted();
      return { forkId: `fork-${source.sourceId}`, sourceId: source.sourceId, kind: source.kind };
    },
    async release(handle) {
      events.push(`fork-release:${handle.sourceId}`);
    },
  };
  const composition: BroadcastCompositionPort = {
    async compose(_program, forks, _consent, signal) {
      events.push("compose");
      signal.throwIfAborted();
      return {
        compositionId: "composition-1",
        sourceIds: forks.map(({ sourceId }) => sourceId),
      };
    },
    async release() {
      events.push("compose-release");
    },
  };
  const publication: BroadcastPublicationPort = {
    capability: {
      capabilityVersion: 1,
      adapterId: "mock-publisher",
      kind: "mock",
      available: true,
      ingestProtocols: ["mock"],
      supportsAudio: true,
      supportsVideo: true,
      supportsSimulcast: true,
    },
    async start(request, signal) {
      events.push("publish-start");
      signal.throwIfAborted();
      if (failPublication) throw new Error("publication_failed");
      return {
        sessionId: "publication-session-1",
        adapterId: "mock-publisher",
        programId: request.program.programId,
        programEpoch: request.program.programEpoch,
      };
    },
    async stop() {
      events.push("publish-stop");
      if (failStop) {
        failStop = false;
        throw new Error("publication_stop_failed");
      }
    },
  };
  const stats: BroadcastStatsPort = {
    subscribe(_session, listener) {
      events.push("stats-subscribe");
      statsListener = listener;
      return () => events.push("stats-unsubscribe");
    },
  };
  const state = new BroadcastProgramStateService();
  const sources = new BroadcastSourceSelectionService();
  const capabilities = new BroadcastDeliveryCapabilityService([publication]);
  const coordinator = new BroadcastCoordinatorService(
    state,
    sources,
    capabilities,
    consent,
    capture,
    composition,
    stats,
    options.direction,
  );
  return {
    coordinator,
    state,
    sources,
    events,
    capture,
    emitStats: () => statsListener?.({
      sampledAt: 100,
      outboundBitsPerSecond: 800_000,
      inboundBitsPerSecond: 0,
      droppedFrames: 1,
    }),
    permitPublication: () => { failPublication = false; },
  };
}

describe("BroadcastCoordinatorService", () => {
  it("binds explicit live video direction to the current composition and withdraws it before stopping", async () => {
    const view: BroadcastVideoDirectionView = { version: 1, compositionId: "composition-1", revision: 1,
      layout: "screen-presenter", activeSourceId: "", sources: [{ sourceId: SOURCE_A, kind: "camera" }] };
    const direction = { videoDirection: vi.fn(() => view), directVideo: vi.fn(() => ({ ...view, revision: 2, layout: "waiting-slate" as const })) };
    const f = fixture({ direction });
    const request = { version: 1 as const, compositionId: view.compositionId, expectedRevision: 1, layout: "waiting-slate" as const, activeSourceId: "" };
    expect(f.coordinator.videoDirection()).toBeNull();
    expect(() => f.coordinator.directVideo(request, "user-action")).toThrow("broadcast_video_direction_unavailable");
    await f.coordinator.start(plan());
    expect(f.coordinator.videoDirection()).toEqual(view);
    expect(() => f.coordinator.directVideo(request, "remote-signal")).toThrow("explicit_broadcast_video_direction_required");
    const before = [...f.events];
    f.coordinator.directVideo(request, "user-action");
    expect(direction.directVideo).toHaveBeenCalledWith({ compositionId: "composition-1", sourceIds: [SOURCE_A, SOURCE_B] }, request);
    expect(f.coordinator.videoDirection()?.revision).toBe(2);
    expect(f.events).toEqual(before);
    const stopping = f.coordinator.stop();
    expect(f.coordinator.videoDirection()).toBeNull();
    expect(() => f.coordinator.directVideo(request, "user-action")).toThrow("broadcast_video_direction_unavailable");
    await stopping; await f.coordinator.destroy();
    expect(() => f.coordinator.directVideo(request, "user-action")).toThrow("broadcast_video_direction_unavailable");
    expect(direction.directVideo).toHaveBeenCalledTimes(1);
  });

  it("does not advertise live direction when the selected composition adapter has no director port", async () => {
    const f = fixture(); await f.coordinator.start(plan());
    expect(f.coordinator.videoDirection()).toBeNull();
    expect(() => f.coordinator.directVideo({ version: 1, compositionId: "composition-1", expectedRevision: 1,
      layout: "single", activeSourceId: "" }, "user-action")).toThrow("broadcast_video_direction_unavailable");
    await f.coordinator.stop();
  });
  it("does not capture in its constructor or when its panel opens", () => {
    const context = fixture();
    const capture = vi.spyOn(context.capture, "fork");

    expect(capture).not.toHaveBeenCalled();
    context.coordinator.setPanelVisible(true);
    expect(context.state.value().panelVisible).toBe(true);
    expect(capture).not.toHaveBeenCalled();
    expect(context.sources.selected()).toEqual([]);
  });

  it("starts only on an explicit action and cleans subscriptions and resources in reverse order", async () => {
    const context = fixture();
    await context.coordinator.start(plan());

    expect(context.events).toEqual([
      "consent",
      `fork:${SOURCE_A}:9`,
      `fork:${SOURCE_B}:9`,
      "compose",
      "publish-start",
      "stats-subscribe",
    ]);
    expect(context.state.value().lifecycle).toBe("running");
    expect(context.sources.selected().map(({ sourceId }) => sourceId)).toEqual([SOURCE_A, SOURCE_B]);
    context.emitStats();
    expect(context.coordinator.latestStats()?.outboundBitsPerSecond).toBe(800_000);

    await context.coordinator.stop();
    expect(context.events.slice(6)).toEqual([
      "stats-unsubscribe",
      "publish-stop",
      "compose-release",
      `fork-release:${SOURCE_B}`,
      `fork-release:${SOURCE_A}`,
    ]);
    expect(context.state.value().lifecycle).toBe("stopped");
    expect(context.sources.selected()).toEqual([]);
    expect(context.coordinator.latestStats()).toBeNull();
    await context.coordinator.stop();
    expect(context.events.filter((event) => event === "publish-stop")).toHaveLength(1);
  });

  it("rejects remote, unknown and mutable plan fields before consent or capture", async () => {
    const context = fixture();
    await expect(context.coordinator.start({
      ...plan(),
      trigger: "remote-signal",
    } as unknown as BroadcastStartPlan)).rejects.toThrow("explicit_broadcast_start_required");
    await expect(context.coordinator.start({
      ...plan(),
      accessToken: "must-not-enter-browser-plan",
    } as unknown as BroadcastStartPlan)).rejects.toThrow("invalid_broadcast_start_plan");
    expect(context.events).toEqual([]);
    expect(context.sources.selected()).toEqual([]);
  });

  it("aborts an in-flight start and never proceeds to a capture fork", async () => {
    const consent: BroadcastConsentPort = {
      authorize(_program, _sources, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        });
      },
    };
    const context = fixture({ consent });
    const capture = vi.spyOn(context.capture, "fork");
    const starting = context.coordinator.start(plan());
    await Promise.resolve();
    const stopping = context.coordinator.stop();

    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await stopping;
    expect(capture).not.toHaveBeenCalled();
    expect(context.state.value().lifecycle).toBe("stopped");
    expect(context.sources.selected()).toEqual([]);
  });

  it("cleans a partial failure and retries only after a second explicit action", async () => {
    const context = fixture({ failPublication: true });
    await expect(context.coordinator.start(plan())).rejects.toThrow("publication_failed");
    expect(context.state.value().lifecycle).toBe("failed");
    expect(context.sources.selected()).toEqual([]);
    expect(context.events.slice(-3)).toEqual([
      "compose-release",
      `fork-release:${SOURCE_B}`,
      `fork-release:${SOURCE_A}`,
    ]);

    context.permitPublication();
    await context.coordinator.retry(plan());
    expect(context.state.value().lifecycle).toBe("running");
    expect(context.events.filter((event) => event === "publish-start")).toHaveLength(2);
    await context.coordinator.destroy();
    expect(context.state.value().lifecycle).toBe("stopped");
    await expect(context.coordinator.start(plan())).rejects.toThrow("broadcast_coordinator_destroyed");
  });

  it("retains a failed cleanup handle and retries it without restarting capture", async () => {
    const context = fixture({ failStopOnce: true });
    await context.coordinator.start(plan());

    await expect(context.coordinator.stop()).rejects.toThrow("publication_stop_failed");
    expect(context.state.value().lifecycle).toBe("failed");
    expect(context.events.filter((event) => event === "publish-stop")).toHaveLength(1);
    expect(context.events.filter((event) => event.startsWith("fork-release:"))).toHaveLength(2);

    await context.coordinator.stop();
    expect(context.events.filter((event) => event === "publish-stop")).toHaveLength(2);
    expect(context.events.filter((event) => event.startsWith("fork:"))).toHaveLength(2);
    expect(context.state.value().lifecycle).toBe("stopped");
  });
});
