import { afterEach, describe, expect, it, vi } from "vitest";
import { createScreenAudioSink } from "./machine-screen-audio-session.service";

function setup() {
  const track = { stop: vi.fn() }, buffers: Float32Array[] = [], nodes: any[] = [];
  const destination = { stream: { getTracks: () => [track] } };
  const context = { sampleRate: 48000, currentTime: 0, state: "running", resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
    createMediaStreamDestination: () => destination,
    createBuffer: () => {
      const data = new Float32Array(4800); buffers.push(data);
      return { copyToChannel: (samples: Float32Array) => data.set(samples), getChannelData: () => data };
    },
    createBufferSource: () => {
      const node = { buffer: null, onended: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() };
      nodes.push(node); return node;
    } };
  vi.stubGlobal("AudioContext", class { constructor() { return context; } });
  const mesh = { attachPublication: vi.fn(), detachPublication: vi.fn() }, controller = new AbortController();
  return { context, track, destination, buffers, nodes, mesh, controller };
}
afterEach(() => vi.unstubAllGlobals());
describe("synthetic screen-audio graph", () => {
  it("routes only into the publication destination and bounds queued buffers before allocation", async () => {
    const f = setup(), sink = await createScreenAudioSink(f.mesh as never, f.controller.signal);
    for (let i = 0; i < 4; i++) sink.write(new Float32Array(4800).fill(.5));
    expect(f.buffers).toHaveLength(4);
    expect(() => sink.write(new Float32Array(4800))).toThrow("meet_screen_audio_queue_or_clock_invalid");
    expect(f.buffers).toHaveLength(4);
    for (const node of f.nodes) expect(node.connect).toHaveBeenCalledWith(f.destination);
    expect(f.mesh.attachPublication).toHaveBeenCalledWith("screen-audio", f.destination.stream);
    sink.close(); sink.close(); expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.mesh.detachPublication).toHaveBeenCalledExactlyOnceWith("screen-audio");
    expect(f.context.close).toHaveBeenCalledOnce();
    for (const buffer of f.buffers) expect(buffer.every(sample => sample === 0)).toBe(true);
  });
  it("abort cleans a graph and a source that failed before start without touching camera or microphone", async () => {
    const f = setup(), sink = await createScreenAudioSink(f.mesh as never, f.controller.signal);
    sink.write(new Float32Array(4800).fill(.5));
    f.nodes[0].stop.mockImplementation(() => { throw new Error("not_started"); });
    f.controller.abort(); sink.close(); expect(f.context.close).toHaveBeenCalledOnce();
    expect(f.mesh.detachPublication.mock.calls).toEqual([["screen-audio"]]);
    expect(f.buffers[0].every(sample => sample === 0)).toBe(true);
  });
  it("denies an unsupported audio rate and a stalled scheduling clock", async () => {
    const f = setup(); f.context.sampleRate = 44100;
    await expect(createScreenAudioSink(f.mesh as never, f.controller.signal)).rejects.toThrow("meet_screen_audio_unsupported");
    expect(f.mesh.attachPublication).not.toHaveBeenCalled(); expect(f.context.close).toHaveBeenCalledOnce();
    const g = setup(), sink = await createScreenAudioSink(g.mesh as never, g.controller.signal);
    sink.write(new Float32Array(4800)); g.context.currentTime = 1;
    expect(() => sink.write(new Float32Array(4800))).toThrow("meet_screen_audio_queue_or_clock_invalid"); sink.close();
  });
});
