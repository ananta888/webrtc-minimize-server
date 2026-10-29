import { signal } from "@angular/core";
import { describe, expect, it } from "vitest";
import { MachineReceiveGate } from "../../webrtc/machine-receive-gate";
import { MachineReceiveObservationService } from "./machine-receive-observation.service";

function fixture() {
  const id = "a".repeat(16), gate = new MachineReceiveGate(() => {});
  gate.setMachine(id, true, ["chat.read"]);
  const peers = signal([{ id, name: "Synthetic KI" }]), media = signal<any[]>([]);
  const session = { joined: signal(true) };
  const mesh = { peerChoices: peers, remoteMedia: media, machineReceive: gate };
  return { id, gate, peers, media, session, service: new MachineReceiveObservationService(mesh as never, session as never) };
}

describe("passive machine receive observation", () => {
  it("shows Hub read and send separately without any consent record", () => {
    const f = fixture(), current = f.service.activities()[0];
    expect(current).toMatchObject({ chatReadSupported: true, chatSendSupported: false, audioSupported: false, videoSupported: false });
    expect(Object.isFrozen(current)).toBe(true);
    expect(f.gate.grants()).toEqual([]);
  });
  it("removes departed peers and all observations after local leave", () => {
    const f = fixture(); expect(f.service.activities()).toHaveLength(1);
    f.peers.set([]); expect(f.service.activities()).toEqual([]);
    f.peers.set([{ id: f.id, name: "Synthetic KI" }]);
    f.session.joined.set(false); expect(f.service.activities()).toEqual([]);
  });
  it("reports only live unmuted tracks for the exact peer", () => {
    const f = fixture();
    f.media.set([{ peerId: f.id, source: "screen", stream: { getTracks: () => [{ readyState: "live", muted: false }] } },
      { peerId: "b".repeat(16), source: "microphone", stream: { getTracks: () => [{ readyState: "live", muted: false }] } },
      { peerId: f.id, source: "camera", stream: { getTracks: () => [{ readyState: "ended", muted: false }] } }]);
    expect(f.service.activities()[0]).toMatchObject({ screenAvailable: true, speechAvailable: false, avatarAvailable: false });
    f.media.set([{ peerId: f.id, source: "screen", stream: { getTracks: () => [{ readyState: "live", muted: true }] } }]);
    expect(f.service.activities()[0].screenAvailable).toBe(false);
  });
});
