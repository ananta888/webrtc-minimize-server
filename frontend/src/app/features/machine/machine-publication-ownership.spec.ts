import { describe, expect, it } from "vitest";
import { MachinePublicationOwnership } from "./machine-publication-ownership";

describe("machine source lifecycle ownership", () => {
  it("reserves coupled sources atomically and never steals the speech microphone", () => {
    const slots = new MachinePublicationOwnership(), speech = slots.claim(["microphone"]);
    expect(() => slots.claim(["camera", "microphone"])).toThrow("meet_machine_publication_busy_or_invalid");
    const camera = slots.claim(["camera"]);
    expect(speech.owns("microphone")).toBe(true); expect(camera.owns("camera")).toBe(true);
    speech.release(); camera.release();
    const mp4 = slots.claim(["microphone", "camera"]);
    expect(() => slots.claim(["microphone"])).toThrow(); mp4.release();
  });
  it("late releases cannot revoke replacement sources or extend a claim", () => {
    const slots = new MachinePublicationOwnership(), source: ("camera" | "microphone")[] = ["microphone"];
    const old = slots.claim(source); source.push("camera");
    expect(old.owns("camera")).toBe(false); old.release();
    const current = slots.claim(["microphone"]); old.release();
    expect(old.owns("microphone")).toBe(false); expect(current.owns("microphone")).toBe(true);
    current.release(); current.release(); expect(current.owns("microphone")).toBe(false);
  });
  it("lets only a parked claim yield, synchronously and only to a complete reservation", () => {
    const slots = new MachinePublicationOwnership(), speech = slots.claim(["microphone"]);
    const camera = slots.claim(["camera"]); let yielded = 0;
    camera.park(() => { yielded++; camera.release(); return true; });
    expect(() => slots.claim(["camera", "microphone"])).toThrow(); expect(yielded).toBe(0); // Microphone stays exclusive.
    camera.resume(); expect(() => slots.claim(["camera"])).toThrow();
    camera.park(() => false); expect(() => slots.claim(["camera"])).toThrow("meet_machine_publication_busy_or_invalid");
    camera.park(() => true); expect(() => slots.claim(["camera"])).toThrow(); // A refusing or non-releasing yield keeps the slot.
    camera.park(() => { yielded++; camera.release(); return true; });
    const next = slots.claim(["camera"]); expect(yielded).toBe(1);
    expect(next.owns("camera")).toBe(true); expect(camera.owns("camera")).toBe(false);
    camera.release(); expect(next.owns("camera")).toBe(true); next.park(() => true); next.release();
    expect(slots.claim(["camera"]).owns("camera")).toBe(true); speech.release();
  });
  it("rejects empty duplicate and unsupported source reservations", () => {
    const slots = new MachinePublicationOwnership();
    for (const sources of [[], ["microphone", "microphone"], ["screen"], ["camera", "microphone", "camera"]]) {
      expect(() => slots.claim(sources as never)).toThrow();
    }
    expect(slots.claim(["camera", "microphone"]).owns("microphone")).toBe(true);
  });
});
