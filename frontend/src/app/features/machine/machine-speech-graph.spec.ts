import { afterEach, describe, expect, it, vi } from "vitest";
import { MachinePublicationOwnership } from "./machine-publication-ownership";
import { MachineSpeechGraphFactory } from "./machine-speech-graph";
import { MachineMediaTimingService } from "./machine-media-timing.service";

function setup() {
  const makeNode = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const track = { kind: "audio", stop: vi.fn() }, stream = { getTracks: () => [track] };
  const output = { ...makeNode(), stream }, quiet = { ...makeNode(), gain: { value: 1 } };
  const context = { sampleRate: 22050, currentTime: 0, state: "running", destination: {},
    audioWorklet: { addModule: vi.fn(async () => {}) }, createMediaStreamDestination: vi.fn(() => output),
    createGain: vi.fn(() => quiet), resume: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const worklet = { ...makeNode(), onprocessorerror: null as null | (() => void),
    port: { onmessage: null as null | ((event: { data: unknown }) => void), postMessage: vi.fn(), close: vi.fn() } };
  const construct = vi.fn();
  vi.stubGlobal("AudioContext", class { constructor() { return context; } });
  vi.stubGlobal("AudioWorkletNode", class { constructor(...args: unknown[]) { construct(...args); return worklet; } });
  const mesh = { attachPublication: vi.fn(), detachPublication: vi.fn(), localPublicationProtected: vi.fn(() => true), overlayReady: () => true };
  const ownership = new MachinePublicationOwnership(), controller = new AbortController();
  const progress = vi.fn(), failed = vi.fn();
  const timing = new MachineMediaTimingService({ joined: () => true, machineLease: () => ({ sessionId: "owned" }) } as never);
  const factory = new MachineSpeechGraphFactory(mesh as never, ownership, timing);
  return { factory, timing, context, worklet, construct, mesh, track, ownership, quiet, progress, failed, controller,
    connect: () => factory.create(441, Date.now() + 5000, progress, failed, controller.signal) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("synthetic speech WebAudio graph", () => {
  it("observes actual Worklet progress and quality failure closes only this graph", async () => {
    let now = 1000; vi.spyOn(performance, "now").mockImplementation(() => now);
    const f = setup(); f.timing.start("independent-owned-live-v1");
    try {
      await f.connect(); const callback = f.worklet.port.onmessage!;
      callback({ data: { type: "progress", playedSamples: 441 } });
      expect(f.timing.snapshot().sources.speech).toMatchObject({ measurement: "pcm-progress", position_us: 20_000 });
      now += 600; callback({ data: { type: "progress", playedSamples: 882 } });
      expect(f.failed).toHaveBeenCalledOnce(); expect(f.track.stop).toHaveBeenCalledOnce();
      expect(f.progress).toHaveBeenCalledTimes(1); expect(f.timing.snapshot().sources.speech!.state).toBe("failed");
      callback({ data: { type: "progress", playedSamples: 1323 } }); expect(f.progress).toHaveBeenCalledTimes(1);
    } finally { f.timing.close(); }
  });
  it("publishes only its own synthetic audio stream and drives a silent local clock", async () => {
    const f = setup(), camera = f.ownership.claim(["camera"]), graph = await f.connect();
    expect(f.mesh.attachPublication).toHaveBeenCalledWith("microphone", expect.anything());
    expect(f.quiet.gain.value).toBe(0);
    expect(f.construct.mock.calls[0][2]).toMatchObject({ numberOfInputs: 0, outputChannelCount: [1],
      processorOptions: { totalSamples: 441 } });
    const pcm = new ArrayBuffer(882); graph.push(0, pcm);
    expect(f.worklet.port.postMessage).toHaveBeenLastCalledWith({ type: "pcm", startSample: 0, pcm }, [pcm]);
    f.worklet.port.onmessage!({ data: { type: "progress", playedSamples: 441 } });
    expect(f.progress).toHaveBeenCalledWith(441);
    graph.close(); graph.close();
    expect(f.mesh.detachPublication).toHaveBeenCalledExactlyOnceWith("microphone");
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.context.close).toHaveBeenCalledOnce();
    expect(camera.owns("camera")).toBe(true); camera.release();
  });

  it("cannot steal the microphone of the coupled MP4 source", async () => {
    const f = setup(), mp4 = f.ownership.claim(["camera", "microphone"]);
    await expect(f.connect()).rejects.toThrow("meet_machine_publication_busy_or_invalid");
    expect(f.context.audioWorklet.addModule).not.toHaveBeenCalled();
    expect(f.mesh.detachPublication).not.toHaveBeenCalled(); expect(mp4.owns("microphone")).toBe(true);
    mp4.release();
  });

  it("waits for this publication and cleans every resource even when the port throws", async () => {
    const f = setup(); f.mesh.localPublicationProtected.mockReturnValue(false);
    const pending = expect(f.connect()).rejects.toThrow();
    await vi.waitFor(() => expect(f.mesh.localPublicationProtected).toHaveBeenCalledWith(f.track));
    f.worklet.port.postMessage.mockImplementation(() => { throw new Error("port closed"); });
    f.controller.abort(); await pending;
    expect(f.worklet.port.close).toHaveBeenCalledOnce(); expect(f.worklet.onprocessorerror).toBeNull();
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.mesh.detachPublication).toHaveBeenCalledOnce();
    expect(f.context.close).toHaveBeenCalledOnce();
  });

  it("does not leak the main-thread context clock into the Worklet's relative budget", async () => {
    const f = setup(); f.context.currentTime = 256 / 22050;
    const graph = await f.factory.create(441, Date.now() + 60000, f.progress, f.failed, f.controller.signal);
    expect(f.construct.mock.calls[0][2]).toMatchObject({ processorOptions: { totalSamples: 441, budgetFrames: 1102500 } });
    graph.close();
  });

  it("aborts a hung setup and rejects late progress without reviving the graph", async () => {
    const f = setup(); let resolve!: () => void;
    f.context.audioWorklet.addModule.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    const pending = expect(f.connect()).rejects.toThrow(); f.controller.abort(); await pending; resolve();
    await Promise.resolve(); expect(f.construct).not.toHaveBeenCalled(); expect(f.context.close).toHaveBeenCalledOnce();
    expect(f.ownership.claim(["microphone"]).owns("microphone")).toBe(true);
  });

  it("releases a partially attached publication if the mesh rejects setup", async () => {
    const f = setup(); f.mesh.attachPublication.mockImplementationOnce(() => { throw new Error("attach failed"); });
    await expect(f.connect()).rejects.toThrow(); expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.mesh.detachPublication).toHaveBeenCalledExactlyOnceWith("microphone");
    expect(f.ownership.claim(["microphone"]).owns("microphone")).toBe(true);
  });

  it("rejects unsupported context rate and malformed Worklet callbacks", async () => {
    const unsupported = setup(); unsupported.context.sampleRate = 48000;
    await expect(unsupported.connect()).rejects.toThrow("meet_speech_rate_unsupported");
    expect(unsupported.construct).not.toHaveBeenCalled();
    const f = setup(), graph = await f.connect();
    const callback = f.worklet.port.onmessage!;
    callback({ data: { type: "progress", playedSamples: 441, private: true } });
    expect(f.failed).toHaveBeenCalledOnce(); expect(f.track.stop).toHaveBeenCalledOnce();
    callback({ data: { type: "progress", playedSamples: 441 } }); expect(f.progress).not.toHaveBeenCalled();
    expect(() => graph.push(0, new ArrayBuffer(882))).toThrow("meet_speech_closed");
  });
});
