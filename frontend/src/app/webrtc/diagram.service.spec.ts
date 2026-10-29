import "@angular/compiler";
import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeDiagramOperation, parseDiagramOperation } from "./diagram-contract";
import { DiagramService } from "./diagram.service";
import { OverlayDelivery, PeerMeshService } from "./peer-mesh.service";
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
  vi.useRealTimers();
});

const OWN = "aaaaaaaaaaaaaaaa";
const REMOTE = "bbbbbbbbbbbbbbbb";
const MACHINE = "cccccccccccccccc";

function createService(options?: {
  ownRole?: string;
  ownPresenter?: boolean;
  diagramPolicy?: "open" | "presenter-only";
  presenterPeerId?: string;
  machinePeer?: boolean;
}) {
  const peerChoices = signal([{ id: REMOTE }, ...(options?.machinePeer ? [{ id: MACHINE }] : [])]);
  const overlayDeliveries = signal<readonly OverlayDelivery[]>([]);
  const mesh = {
    peerChoices,
    membershipEpoch: signal(2),
    overlayDeliveries,
    machineReceive: { isMachine: (id: string) => id === MACHINE },
    sendOverlayData: vi.fn(async () => true),
  } as unknown as PeerMeshService;

  const session = {
    joined: signal(true),
    peerId: signal(OWN),
  } as unknown as RoomSessionService;

  const moderation = {
    ownRole: signal(options?.ownRole ?? "owner"),
    ownPresenter: signal(options?.ownPresenter ?? false),
    diagramPolicy: signal(options?.diagramPolicy ?? "open"),
    presenterPeerId: signal(options?.presenterPeerId ?? ""),
    participants: signal([
      { peerId: OWN, role: options?.ownRole ?? "owner" },
      { peerId: REMOTE, role: options?.ownRole === "participant" ? "owner" : "participant" },
    ]),
  } as unknown as RoomModerationService;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: DiagramService,
        useFactory: () => new DiagramService(mesh, session, moderation),
      },
    ],
  });

  const service = TestBed.inject(DiagramService);
  return { service, mesh, overlayDeliveries, session, moderation };
}

function remoteDelivery(kind: "snapshot" | "tool" | "lock" | "sync-request", payload: unknown, id: number, opIdChar = "d") {
  const operation = parseDiagramOperation({
    version: 1,
    type: "diagram-op",
    opId: opIdChar.repeat(32),
    membershipEpoch: 2,
    authorPeerId: REMOTE,
    kind,
    payload,
  })!;
  return {
    id,
    originPeerId: REMOTE,
    trafficClass: kind === "snapshot" ? "bulk" : "event",
    data: encodeDiagramOperation(operation),
  } as OverlayDelivery;
}

describe("DiagramService", () => {
  it("publishes snapshots locally and fans them out as bulk to human peers", () => {
    const { service, mesh } = createService({ machinePeer: true });
    expect(service.publishSnapshot("bpmn", "<definitions/>")).toBe(true);
    expect(service.doc("bpmn")).toEqual({
      tool: "bpmn", xml: "<definitions/>", revision: 1, authorPeerId: OWN,
    });
    const calls = (mesh.sendOverlayData as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(REMOTE);
    expect(calls[0][2]).toBe("bulk");
  });

  it("refuses local edits without edit rights and recovers with the policy switch", () => {
    const { service, mesh } = createService({ ownRole: "participant", diagramPolicy: "presenter-only" });
    expect(service.canEdit()).toBe(false);
    expect(service.publishSnapshot("bpmn", "<a/>")).toBe(false);
    expect(service.setTool("drawio")).toBe(false);
    expect(service.setLock("Task_1", true)).toBe(false);
    expect(mesh.sendOverlayData).not.toHaveBeenCalled();
  });

  it("accepts newer remote snapshots via overlay deliveries and ignores older ones", () => {
    const { service, overlayDeliveries } = createService();
    overlayDeliveries.set([remoteDelivery("snapshot", { tool: "bpmn", xml: "<remote/>", revision: 4 }, 1)]);
    TestBed.tick();
    expect(service.doc("bpmn")).toEqual({
      tool: "bpmn", xml: "<remote/>", revision: 4, authorPeerId: REMOTE,
    });
    overlayDeliveries.set([
      remoteDelivery("snapshot", { tool: "bpmn", xml: "<remote/>", revision: 4 }, 1),
      remoteDelivery("snapshot", { tool: "bpmn", xml: "<stale/>", revision: 2 }, 2, "e"),
    ]);
    TestBed.tick();
    expect(service.doc("bpmn")?.xml).toBe("<remote/>");
  });

  it("coalesces rapid local edits into a single debounced snapshot", () => {
    const { service, mesh } = createService();
    vi.useFakeTimers();
    service.scheduleSnapshot("bpmn", "<v1/>");
    service.scheduleSnapshot("bpmn", "<v2/>");
    expect(mesh.sendOverlayData).not.toHaveBeenCalled();
    vi.advanceTimersByTime(850);
    expect(mesh.sendOverlayData).toHaveBeenCalledTimes(1);
    expect(service.doc("bpmn")?.xml).toBe("<v2/>");
  });

  it("synchronises the tool choice and cooperative element locks", () => {
    const { service, mesh } = createService();
    expect(service.setTool("drawio")).toBe(true);
    expect(service.activeTool()).toBe("drawio");
    expect(service.setLock("Activity_1", true)).toBe(true);
    expect(service.locks().get("Activity_1")).toEqual({ ownerPeerId: OWN, expiresAt: expect.any(Number) });
    expect((mesh.sendOverlayData as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]))
      .toEqual(["event", "event"]);
  });

  it("requests sync on late join and responds only as owner or without a connected owner", () => {
    const owner = createService();
    owner.service.publishSnapshot("bpmn", "<late/>");
    (owner.mesh.sendOverlayData as ReturnType<typeof vi.fn>).mockClear();
    owner.overlayDeliveries.set([remoteDelivery("sync-request", {}, 1, "f")]);
    TestBed.tick();
    const responses = (owner.mesh.sendOverlayData as ReturnType<typeof vi.fn>).mock.calls;
    expect(responses).toHaveLength(1);
    expect(responses[0][0]).toBe(REMOTE);
    expect(responses[0][2]).toBe("bulk");

    const participant = createService({ ownRole: "participant" });
    participant.service.publishSnapshot("bpmn", "<x/>");
    (participant.mesh.sendOverlayData as ReturnType<typeof vi.fn>).mockClear();
    participant.overlayDeliveries.set([remoteDelivery("sync-request", {}, 1, "f")]);
    TestBed.tick();
    expect(participant.mesh.sendOverlayData).not.toHaveBeenCalled();
  });

  it("flushes a pending debounced snapshot immediately and exactly once", () => {
    const { service, mesh } = createService();
    vi.useFakeTimers();
    service.scheduleSnapshot("bpmn", "<pending/>");
    service.flushSnapshot();
    expect(mesh.sendOverlayData).toHaveBeenCalledTimes(1);
    expect(service.doc("bpmn")?.xml).toBe("<pending/>");
    vi.advanceTimersByTime(850);
    expect(mesh.sendOverlayData).toHaveBeenCalledTimes(1);
  });

  it("drops machine-originated deliveries", () => {
    const { service, overlayDeliveries } = createService();
    const operation = parseDiagramOperation({
      version: 1,
      type: "diagram-op",
      opId: "9".repeat(32),
      membershipEpoch: 2,
      authorPeerId: MACHINE,
      kind: "snapshot",
      payload: { tool: "bpmn", xml: "<machine/>", revision: 9 },
    })!;
    overlayDeliveries.set([{
      id: 1,
      originPeerId: MACHINE,
      trafficClass: "bulk",
      data: encodeDiagramOperation(operation),
    } as OverlayDelivery]);
    TestBed.tick();
    expect(service.doc("bpmn")).toBeNull();
  });
});
