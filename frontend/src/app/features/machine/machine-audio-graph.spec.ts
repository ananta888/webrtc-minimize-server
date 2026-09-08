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
  const collector = { port: { onmessage: null as null | ((event: { data: any }) => void), postMessage: vi.fn(), close: vi.fn() }, ...node() };
  vi.stubGlobal("AudioWorkletNode", class { constructor() { return collector; } });
  vi.stubGlobal("MediaStream", class { constructor(readonly tracks: unknown[]) {} });
  const clone = { stop: vi.fn() }, track = { kind: "audio", readyState: "live", muted: false, enabled: true, clone: () => clone, stop: vi.fn() };
  return { sink, context, clone, track, collector, factory: new MachineAudioGraphFactory(), controller: new AbortController() };
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
it.each(["closed", "aborted", "malformed", "consumer"])("wipes owned PCM rejected by %s and never acknowledges it", async reason => {
  const f = setup(), consume = vi.fn(), failed = vi.fn();
  const graph = await f.factory.connect(f.track as never, consume, failed, f.controller.signal);
  const callback = f.collector.port.onmessage!;
  if (reason === "closed") await graph.close();
  if (reason === "aborted") f.controller.abort();
  if (reason === "consumer") consume.mockImplementation(() => { throw new Error("rejected"); });
  const bytes = new Uint8Array(3200).fill(123);
  callback({ data: { type: "pcm", startSample: 0, pcm: bytes.buffer, ...(reason === "malformed" ? { unknown: true } : {}) } });
  expect(bytes.every(byte => byte === 0)).toBe(true);
  expect(f.collector.port.postMessage.mock.calls.some(([value]) => value.type === "ack")).toBe(false);
  expect(consume).toHaveBeenCalledTimes(reason === "consumer" ? 1 : 0);
  await graph.close();
});
it("transfers a valid buffer to its consumer without prematurely wiping queued samples", async () => {
  const f = setup(), consume = vi.fn();
  const graph = await f.factory.connect(f.track as never, consume, vi.fn(), f.controller.signal);
  const bytes = new Uint8Array(3200).fill(123);
  f.collector.port.onmessage!({ data: { type: "pcm", startSample: 0, pcm: bytes.buffer } });
  expect(consume).toHaveBeenCalledWith(0, bytes.buffer);
  expect(bytes.every(byte => byte === 123)).toBe(true);
  expect(f.collector.port.postMessage).toHaveBeenCalledWith({ type: "ack", startSample: 0 });
  bytes.fill(0); await graph.close();
});
it("attempts every owned resource cleanup even if the worklet stop message or sink pause throws", async () => {
  const f = setup();
  const graph = await f.factory.connect(f.track as never, vi.fn(), vi.fn(), f.controller.signal);
  f.collector.port.postMessage.mockImplementation(() => { throw new Error("port failed"); });
  f.sink.pause.mockImplementation(() => { throw new Error("sink failed"); });
  await expect(graph.close()).resolves.toBeUndefined();
  expect(f.collector.port.onmessage).toBeNull(); expect(f.collector.port.close).toHaveBeenCalledOnce();
  expect(f.collector.disconnect).toHaveBeenCalledOnce(); expect(f.sink.srcObject).toBeNull();
  expect(f.clone.stop).toHaveBeenCalledOnce(); expect(f.context.close).toHaveBeenCalledOnce();
});
it("releases the clone when sink construction fails before audio context creation", async () => {
  const f = setup(); vi.spyOn(document, "createElement").mockImplementation(() => { throw new Error("sink setup failed"); });
  await expect(f.factory.connect(f.track as never, vi.fn(), vi.fn(), f.controller.signal)).rejects.toThrow("sink setup failed");
  expect(f.clone.stop).toHaveBeenCalledOnce(); expect(f.context.close).not.toHaveBeenCalled();
  expect(f.track.stop).not.toHaveBeenCalled();
});
it("cannot interrupt cleanup by throwing from the failure observer", async () => {
  const f = setup(), failed = vi.fn(() => { throw new Error("observer failed"); });
  await f.factory.connect(f.track as never, vi.fn(), failed, f.controller.signal);
  const bytes = new Uint8Array(3200).fill(17);
  expect(() => f.collector.port.onmessage!({ data: { type: "pcm", startSample: -1, pcm: bytes.buffer } })).not.toThrow();
  expect(bytes.every(byte => byte === 0)).toBe(true); expect(failed).toHaveBeenCalledOnce();
  expect(f.clone.stop).toHaveBeenCalledOnce(); expect(f.context.close).toHaveBeenCalledOnce();
});
