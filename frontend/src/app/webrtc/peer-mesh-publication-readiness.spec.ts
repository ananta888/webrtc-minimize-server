import { describe, expect, it } from "vitest";
import { PeerMeshService } from "./peer-mesh.service";

// Exercise only the existing mesh's read-only projection, with no signaling or key issuance.
function setup() {
  const track = { id: "speech", readyState: "live" };
  const mesh = Object.assign(Object.create(PeerMeshService.prototype), {
    publications: new Map([["speech", { id: "speech", local: true, track }]]),
    membershipStable: true, mediaE2eeState: () => "active", shouldProtectMedia: () => true,
    membershipEpoch: () => 2, mediaAgents: { routeEpoch: () => 3 }, agentMediaKeys: new Map(),
    connections: { peers: new Map([["peer", { id: "peer", pc: { connectionState: "connected" }, senders: new Map([["speech", {}]]) }]]) },
    activeSenderMediaContexts: new Set(["out:screen:peer"]),
  });
  return { mesh, track, ready: () => mesh.localPublicationProtected(track) };
}
describe("exact local publication protection", () => {
  it("does not mistake another active publication for speech readiness", () => {
    const f = setup(); expect(f.ready()).toBe(false);
    f.mesh.activeSenderMediaContexts.add("out:speech:peer"); expect(f.ready()).toBe(true);
    expect(f.mesh.localPublicationProtected({ ...f.track })).toBe(false);
    f.mesh.membershipStable = false; expect(f.ready()).toBe(false);
  });
  it("rejects pending keys, disconnected routes, ended or nonlocal tracks", () => {
    const f = setup(); f.mesh.activeSenderMediaContexts.add("out:speech:peer");
    f.mesh.mediaE2eeState = () => "pending"; expect(f.ready()).toBe(false);
    f.mesh.mediaE2eeState = () => "active"; f.mesh.peers.get("peer").pc.connectionState = "disconnected";
    expect(f.ready()).toBe(false); f.mesh.peers.get("peer").pc.connectionState = "connected";
    f.track.readyState = "ended"; expect(f.ready()).toBe(false);
    f.track.readyState = "live"; f.mesh.publications.get("speech").local = false; expect(f.ready()).toBe(false);
  });
  it("requires the current active protected agent route", () => {
    const f = setup(), key = { active: true, message: { membershipEpoch: 2 }, routeEpoch: 3, contextId: "agent-speech" };
    f.mesh.agentMediaKeys.set("speech", key); f.mesh.activeSenderMediaContexts.add(key.contextId);
    expect(f.ready()).toBe(true); key.routeEpoch = 2; expect(f.ready()).toBe(false);
    key.routeEpoch = 3; key.message.membershipEpoch = 1; expect(f.ready()).toBe(false);
  });
});
