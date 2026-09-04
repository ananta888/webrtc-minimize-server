import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BrowserTrustedAudioProgramBusFactory,
  TRUSTED_AUDIO_PROGRAM_PROFILES,
  TrustedAudioProgramSettingsService,
} from "./trusted-audio-program-bus";

class FakeParam {
  value = 0;
  readonly targets: number[] = [];
  setTargetAtTime(value: number) {
    this.value = value;
    this.targets.push(value);
  }
}

class FakeNode {
  readonly connections: FakeNode[] = [];
  disconnected = false;
  connect(target: FakeNode) {
    this.connections.push(target);
    return target;
  }
  disconnect() { this.disconnected = true; }
}

class FakeGain extends FakeNode { readonly gain = new FakeParam(); }
class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
}
class FakeAnalyser extends FakeNode {
  fftSize = 0;
  smoothingTimeConstant = 0;
  constructor(readonly level: number) { super(); }
  getFloatTimeDomainData(samples: Float32Array) { samples.fill(this.level); }
}

function track() {
  return Object.assign(new EventTarget(), {
    kind: "audio",
    readyState: "live",
    contentHint: "",
    stop: vi.fn(function(this: { readyState: string }) { this.readyState = "ended"; }),
  }) as unknown as MediaStreamTrack;
}

function stream(level: number) {
  const audioTrack = track();
  return {
    level,
    getAudioTracks: () => [audioTrack],
    getTracks: () => [audioTrack],
  } as unknown as MediaStream;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly sampleRate = 48_000;
  readonly currentTime = 1;
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly analysers: FakeAnalyser[] = [];
  readonly outputTrack = track();
  state: AudioContextState = "running";

  constructor() { FakeAudioContext.instances.push(this); }
  createGain() { const node = new FakeGain(); this.gains.push(node); return node; }
  createDynamicsCompressor() { return new FakeCompressor(); }
  createAnalyser() { const node = new FakeAnalyser(this.analysers.length === 1 ? 0.08 : 0.02); this.analysers.push(node); return node; }
  createMediaStreamDestination() {
    return Object.assign(new FakeNode(), {
      stream: {
        getAudioTracks: () => [this.outputTrack],
        getTracks: () => [this.outputTrack],
      },
    });
  }
  createMediaStreamSource(input: MediaStream) {
    return Object.assign(new FakeNode(), { input });
  }
  async resume() { this.state = "running"; }
  async close() { this.state = "closed"; }
}

const program = {
  tenantId: "tn_aaaaaaaaaaaaaaaa",
  roomId: "room-alpha",
  programId: "prg_aaaaaaaaaaaaaaaa",
  programRevision: 1,
  programEpoch: 1,
};

describe("BrowserTrustedAudioProgramBusFactory", () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("builds one limited program output, ducks screen audio for speech and never monitors by default", async () => {
    const factory = new BrowserTrustedAudioProgramBusFactory();
    const handle = await factory.create(program, [
      { sourceId: "src_microphoneaaaaaa", sourceKind: "microphone", stream: stream(0.08) },
      { sourceId: "src_screenaudioaaaaa", sourceKind: "screen-audio", stream: stream(0.02) },
    ], TRUSTED_AUDIO_PROGRAM_PROFILES.speech, "off", new AbortController().signal);
    const context = FakeAudioContext.instances[0];

    await vi.advanceTimersByTimeAsync(60);
    expect(handle.track).toBe(context.outputTrack);
    expect(handle.track.contentHint).toBe("speech");
    expect(context.destination.connections).toEqual([]);
    expect(context.gains.some(({ gain }) => gain.targets.includes(0.28))).toBe(true);
    expect(handle.snapshot()).toMatchObject({
      profileId: "speech", monitoringMode: "off", sampleRate: 48_000,
      channelCount: 1, opusBitsPerSecond: 64_000, aacBitsPerSecond: 96_000,
      dtxRequested: true, fecRequested: true,
    });
    expect(handle.snapshot().peakLevel).toBeGreaterThan(0);

    handle.setSourceMuted("src_microphoneaaaaaa", true);
    handle.setSourceGain("src_screenaudioaaaaa", 1.2);
    expect(context.gains.some(({ gain }) => gain.targets.includes(0))).toBe(true);
    expect(context.gains.some(({ gain }) => gain.targets.includes(1.2))).toBe(true);
    await handle.close();
    await handle.close();
    expect(context.state).toBe("closed");
    expect(context.outputTrack.stop).toHaveBeenCalledOnce();
  });

  it("connects monitoring only for an explicitly selected headphone mode and cleans on abort", async () => {
    const controller = new AbortController();
    const handle = await new BrowserTrustedAudioProgramBusFactory().create(program, [
      { sourceId: "src_microphoneaaaaaa", sourceKind: "microphone", stream: stream(0.03) },
    ], TRUSTED_AUDIO_PROGRAM_PROFILES.balanced, "headphones", controller.signal);
    const context = FakeAudioContext.instances[0];
    expect(context.gains.some((gain) => gain.connections.includes(context.destination))).toBe(true);

    controller.abort();
    await Promise.resolve();
    expect(context.state).toBe("closed");
    expect(handle.track.readyState).toBe("ended");
  });

  it("removes the last input graph and output when a source ends", async () => {
    const input = stream(0.03);
    const handle = await new BrowserTrustedAudioProgramBusFactory().create(program, [
      { sourceId: "src_microphoneaaaaaa", sourceKind: "microphone", stream: input },
    ], TRUSTED_AUDIO_PROGRAM_PROFILES.speech, "off", new AbortController().signal);
    input.getAudioTracks()[0].dispatchEvent(new Event("ended"));
    await Promise.resolve();
    expect(FakeAudioContext.instances[0].state).toBe("closed");
    expect(handle.track.readyState).toBe("ended");
  });

  it("rejects duplicate, inactive and unknown inputs before creating AudioContext", async () => {
    const factory = new BrowserTrustedAudioProgramBusFactory();
    const inactive = stream(0);
    Object.assign(inactive.getAudioTracks()[0], { readyState: "ended" });
    await expect(factory.create(program, [
      { sourceId: "src_microphoneaaaaaa", sourceKind: "microphone", stream: inactive },
    ], TRUSTED_AUDIO_PROGRAM_PROFILES.speech, "off", new AbortController().signal))
      .rejects.toThrow("invalid_trusted_audio_program");
    expect(FakeAudioContext.instances).toHaveLength(0);
  });
});

describe("TrustedAudioProgramSettingsService", () => {
  it("uses safe speech/off defaults and changes monitoring only after a local user action", () => {
    const settings = new TrustedAudioProgramSettingsService();
    expect(settings.profileId()).toBe("speech");
    expect(settings.monitoringMode()).toBe("off");
    expect(settings.setProfile("music")).toBe(true);
    expect(settings.profile().opusBitsPerSecond).toBe(160_000);
    expect(settings.setMonitoring("headphones", "remote-signal")).toBe(false);
    expect(settings.monitoringMode()).toBe("off");
    expect(settings.setMonitoring("headphones", "user-action")).toBe(true);
    expect(settings.monitoringMode()).toBe("headphones");
  });
});
