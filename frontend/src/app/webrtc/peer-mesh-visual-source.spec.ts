import { expect, it, vi } from "vitest";
import { PeerMeshService } from "./peer-mesh.service";

function setup() {
  const track = { kind: "video", readyState: "live", muted: false, enabled: true };
  const publication = { rootPeerId: "human", source: "camera", local: false, track };
  const descriptor = { rootPeerId: "human", source: "camera" };
  const epoch = { peerId: "human", source: "camera", epoch: 2 };
  const mesh = Object.assign(Object.create(PeerMeshService.prototype), {
    ownId: "machine", connections: { peers: new Map([["human", {}]]) },
    publications: new Map([["camera", publication]]), descriptors: new Map([["camera", descriptor]]),
    visualEpochs: new Map([["camera", epoch]]), shouldProtectMedia: vi.fn(() => true),
    machineReceive: { isMachine: vi.fn(id => id === "machine"), supports: vi.fn(() => true), mediaAllowed: vi.fn(() => true) },
  });
  return { mesh, track, publication, descriptor, epoch };
}
it("projects only an exact currently authorized remote visual source with its server epoch", () => {
  const f = setup(); expect(f.mesh.machineVisualSource("camera")).toEqual({ peerId: "human", source: "camera", publicationEpoch: 2, track: f.track });
  expect(f.mesh.machineReceive.mediaAllowed).toHaveBeenCalledWith("machine", "human", "camera", "camera");
});
it.each(["capability", "own-kind", "publisher-kind", "grant", "local", "descriptor", "descriptor-peer", "descriptor-source",
  "epoch", "epoch-peer", "epoch-source", "peer", "kind", "source", "muted", "disabled", "ended", "protection"])(
  "does not expose a visual track on %s mismatch", kind => {
    const f = setup();
    if (kind === "capability") f.mesh.machineReceive.supports.mockReturnValue(false);
    if (kind === "own-kind") f.mesh.machineReceive.isMachine.mockReturnValue(false);
    if (kind === "publisher-kind") f.mesh.machineReceive.isMachine.mockReturnValue(true);
    if (kind === "grant") f.mesh.machineReceive.mediaAllowed.mockReturnValue(false);
    if (kind === "local") f.publication.local = true;
    if (kind === "descriptor") f.mesh.descriptors.clear();
    if (kind === "descriptor-peer") f.descriptor.rootPeerId = "other";
    if (kind === "descriptor-source") f.descriptor.source = "screen";
    if (kind === "epoch") f.mesh.visualEpochs.clear();
    if (kind === "epoch-peer") f.epoch.peerId = "other";
    if (kind === "epoch-source") f.epoch.source = "screen";
    if (kind === "peer") f.mesh.peers.clear();
    if (kind === "kind") f.track.kind = "audio";
    if (kind === "source") f.publication.source = f.descriptor.source = f.epoch.source = "microphone";
    if (kind === "muted") f.track.muted = true;
    if (kind === "disabled") f.track.enabled = false;
    if (kind === "ended") f.track.readyState = "ended";
    if (kind === "protection") f.mesh.shouldProtectMedia.mockReturnValue(false);
    expect(() => f.mesh.machineVisualSource("camera")).toThrow("meet_visual_source_denied");
  });
