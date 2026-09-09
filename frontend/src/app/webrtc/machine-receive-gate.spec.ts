import { afterEach, expect, it, vi } from "vitest";
import { MachineReceiveGate } from "./machine-receive-gate";

const human = "aaaaaaaaaaaaaaaa", machine = "bbbbbbbbbbbbbbbb", roomId = "room-111111111111111111";
const grant = () => ({ publisherPeerId: human, machinePeerId: machine, publicationIds: ["mic"], chatRead: true, expiresAt: Date.now() + 60_000 });
function fixture() {
  const changed = vi.fn(), gate = new MachineReceiveGate(changed);
  gate.setMachine(human, false); gate.setMachine(machine, true, ["audio.receive", "chat.read"]);
  const apply = (grants = [grant()], revision = 1) => gate.apply({ type: "machine-receive-state", version: 1, roomId, revision, grants }, roomId);
  return { gate, changed, apply };
}
afterEach(() => vi.useRealTimers());
it.each(["camera", "screen"])("separately granted %s keys require video.receive and exact scope", source => {
  const f = fixture();
  const g = { ...grant(), publicationIds: ["visual"], chatRead: false };
  f.apply([g]);
  expect(f.gate.mediaAllowed(machine, human, "visual", source)).toBe(false);
  f.gate.setMachine(machine, true, ["video.receive"]);
  expect(f.gate.mediaAllowed(machine, human, "visual", source)).toBe(true);
  expect(f.gate.mediaAllowed(machine, human, "visual", "microphone")).toBe(false);
  expect(f.gate.mediaAllowed(machine, human, "other", source)).toBe(false);
  f.gate.setMachine(machine, true, ["avatar.publish", "screen.publish"]);
  expect(f.gate.mediaAllowed(machine, human, "visual", source)).toBe(false); f.gate.clear();
});
it("machine receive defaults denied without changing human transport", () => {
  const f = fixture();
  expect(f.gate.mediaAllowed(machine, human, "mic", "microphone")).toBe(false);
  expect(f.gate.chatAllowed(machine, human)).toBe(false);
  expect(f.gate.mediaAllowed(human, machine, "avatar", "camera")).toBe(true);
  f.gate.clear();
});
it("only the exact publication/sender/receiver audio scope receives a key", () => {
  const f = fixture(); f.apply();
  expect(f.gate.mediaAllowed(machine, human, "mic", "microphone")).toBe(true);
  for (const [publisher, publication, source] of [[human, "mic", "camera"], [human, "other", "microphone"], [machine, "mic", "microphone"]]) {
    expect(f.gate.mediaAllowed(machine, publisher, publication, source)).toBe(false);
  }
  expect(f.gate.chatAllowed(machine, human)).toBe(true);
  f.apply([], 2); expect(f.changed).toHaveBeenCalledTimes(2);
  expect(f.gate.mediaAllowed(machine, human, "mic", "microphone")).toBe(false); f.gate.clear();
});
it("expiry requests rotation independently of receipt delivery", () => {
  vi.useFakeTimers(); const f = fixture(); f.apply();
  vi.advanceTimersByTime(60_001);
  expect(f.changed).toHaveBeenCalledTimes(2); expect(f.gate.grants()).toEqual([]);
  expect(f.gate.chatAllowed(machine, human)).toBe(false); f.gate.clear();
});
it("same revision cannot be repurposed and malformed policy revokes locally", () => {
  const f = fixture(); const g = grant(); f.apply([g]); f.apply([g]);
  expect(f.changed).toHaveBeenCalledTimes(1);
  expect(() => f.apply([{ ...g, publicationIds: ["other"] }])).toThrow();
  expect(f.gate.grants()).toEqual([]); f.gate.clear();
});
it("wrong room, unknown fields, stale revision, unknown members and duplicate grants fail closed", () => {
  for (const patch of [{ roomId: "other" }, { tools: true }, { revision: -1 },
    { grants: [{ ...grant(), publisherPeerId: "cccccccccccccccc" }] }, { grants: [grant(), grant()] }]) {
    const f = fixture(); f.apply();
    expect(() => f.gate.apply({ type: "machine-receive-state", version: 1, roomId, revision: 2, grants: [grant()], ...patch }, roomId)).toThrow();
    expect(f.gate.grants()).toEqual([]); f.gate.clear();
  }
});
