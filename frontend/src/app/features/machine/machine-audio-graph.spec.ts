import { afterEach, expect, it, vi } from "vitest";
import { MachineAudioGraphFactory } from "./machine-audio-graph";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup() {
  const sink = { volume: 1, srcObject: null as unknown, play: vi.fn(async () => {}), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() };
  vi.spyOn(document, "createElement").mockReturnValue(sink as never);
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const context = { sampleRate: 16000, state: "running", destination: {}, audioWorklet: { addModule: vi.fn(async () => {}) },
    createMediaStreamSource: vi.fn(node), createGain: () => ({ ...node(), gain: { value: 1 } }),
    resume: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  vi.stubGlobal("AudioContext", class { constructor() { return context; } });
  vi.stubGlobal("AudioWorkletNode", class { port = { onmessage: null, postMessage: vi.fn(), close: vi.fn() }; connect = vi.fn(); disconnect = vi.fn(); });
  vi.stubGlobal("MediaStream", class { constructor(readonly tracks: unknown[]) {} });
  const clone = { stop: vi.fn() }, track = { kind: "audio", readyState: "live", muted: false, enabled: true, clone: () => clone, stop: vi.fn() };
  return { sink, context, clone, track, factory: new MachineAudioGraphFactory(), controller: new AbortController() };
}
it("owns a silent decoder sink and clone, never the publisher track or a capture API", async () => {
  const f = setup();
  const graph = await f.factory.connect(f.track as never, vi.fn(), vi.fn(), f.controller.signal);
  expect(f.sink.volume).toBe(0); expect(f.sink.play).toHaveBeenCalledOnce();
  await graph.close(); await graph.close();
  expect(f.sink.srcObject).toBeNull(); expect(f.sink.pause).toHaveBeenCalledOnce();
  expect(f.clone.stop).toHaveBeenCalledOnce(); expect(f.track.stop).not.toHaveBeenCalled();
  expect(f.context.close).toHaveBeenCalledOnce();
});
it("cleans a rejected or aborted playout setup without leaving a live source", async () => {
  const f = setup(); f.sink.play.mockRejectedValue(new Error("playout denied"));
  await expect(f.factory.connect(f.track as never, vi.fn(), vi.fn(), f.controller.signal)).rejects.toThrow();
  expect(f.sink.srcObject).toBeNull(); expect(f.clone.stop).toHaveBeenCalledOnce();
  expect(f.context.close).toHaveBeenCalledOnce();
});
