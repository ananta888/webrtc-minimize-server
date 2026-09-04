import { InjectionToken, Injectable, signal } from "@angular/core";

import { BroadcastBrowserPortError, BroadcastProgramRef } from "./broadcast-ports";

export type TrustedAudioProgramProfileId = "speech" | "balanced" | "music";
export type TrustedAudioProgramPriority = "speech" | "screen-audio" | "balanced";
export type TrustedAudioMonitoringMode = "off" | "headphones";

export interface TrustedAudioProgramProfile {
  readonly profileVersion: 1;
  readonly profileId: TrustedAudioProgramProfileId;
  readonly priority: TrustedAudioProgramPriority;
  readonly opusBitsPerSecond: number;
  readonly aacBitsPerSecond: number;
  readonly channelCount: 1 | 2;
  readonly dtx: boolean;
  readonly fec: boolean;
  readonly microphoneGain: number;
  readonly screenAudioGain: number;
  readonly remoteGain: number;
  readonly duckingGain: number;
  readonly duckingThreshold: number;
}

export interface TrustedAudioProgramInput {
  readonly sourceId: string;
  readonly sourceKind: "microphone" | "screen-audio";
  readonly stream: MediaStream;
}

export interface TrustedAudioProgramSnapshot {
  readonly profileId: TrustedAudioProgramProfileId;
  readonly monitoringMode: TrustedAudioMonitoringMode;
  readonly sampleRate: number;
  readonly channelCount: 1 | 2;
  readonly opusBitsPerSecond: number;
  readonly aacBitsPerSecond: number;
  readonly dtxRequested: boolean;
  readonly fecRequested: boolean;
  readonly sourceLevels: Readonly<Record<string, number>>;
  readonly peakLevel: number;
}

export interface TrustedAudioProgramHandle {
  readonly outputSourceId: string;
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack;
  snapshot(): TrustedAudioProgramSnapshot;
  setSourceMuted(sourceId: string, muted: boolean): void;
  setSourceGain(sourceId: string, gain: number): void;
  close(): Promise<void>;
}

export interface TrustedAudioProgramBusFactory {
  readonly supported: boolean;
  create(
    program: BroadcastProgramRef,
    inputs: readonly TrustedAudioProgramInput[],
    profile: TrustedAudioProgramProfile,
    monitoringMode: TrustedAudioMonitoringMode,
    signal: AbortSignal,
  ): Promise<TrustedAudioProgramHandle>;
}

const SOURCE_ID = /^src_[A-Za-z0-9_-]{16,64}$/;

export const TRUSTED_AUDIO_PROGRAM_PROFILES: Readonly<Record<TrustedAudioProgramProfileId, TrustedAudioProgramProfile>> =
  Object.freeze({
    speech: Object.freeze({
      profileVersion: 1, profileId: "speech", priority: "speech", opusBitsPerSecond: 64_000,
      aacBitsPerSecond: 96_000, channelCount: 1, dtx: true, fec: true,
      microphoneGain: 1, screenAudioGain: 0.72, remoteGain: 0.82,
      duckingGain: 0.28, duckingThreshold: 0.045,
    }),
    balanced: Object.freeze({
      profileVersion: 1, profileId: "balanced", priority: "balanced", opusBitsPerSecond: 96_000,
      aacBitsPerSecond: 128_000, channelCount: 2, dtx: false, fec: true,
      microphoneGain: 1, screenAudioGain: 0.88, remoteGain: 0.88,
      duckingGain: 0.5, duckingThreshold: 0.06,
    }),
    music: Object.freeze({
      profileVersion: 1, profileId: "music", priority: "screen-audio", opusBitsPerSecond: 160_000,
      aacBitsPerSecond: 192_000, channelCount: 2, dtx: false, fec: false,
      microphoneGain: 0.82, screenAudioGain: 1, remoteGain: 0.9,
      duckingGain: 0.72, duckingThreshold: 0.09,
    }),
  });

function fail(code: string): never {
  throw new BroadcastBrowserPortError(code);
}

function outputSourceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `src_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function boundedGain(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) {
    fail("invalid_trusted_audio_gain");
  }
  return value;
}

function sourceLevel(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(samples);
  let squareSum = 0;
  for (const sample of samples) squareSum += sample * sample;
  return Math.min(1, Math.sqrt(squareSum / samples.length) * 2.8);
}

interface InputGraph {
  readonly input: TrustedAudioProgramInput;
  readonly source: MediaStreamAudioSourceNode;
  readonly gain: GainNode;
  readonly duck: GainNode;
  readonly analyser: AnalyserNode;
  readonly samples: Float32Array<ArrayBuffer>;
  readonly track: MediaStreamTrack;
  ended: (() => void) | null;
  muted: boolean;
  configuredGain: number;
}

export class BrowserTrustedAudioProgramBusFactory implements TrustedAudioProgramBusFactory {
  readonly supported = typeof AudioContext === "function";

  async create(
    program: BroadcastProgramRef,
    inputs: readonly TrustedAudioProgramInput[],
    profile: TrustedAudioProgramProfile,
    monitoringMode: TrustedAudioMonitoringMode,
    signal: AbortSignal,
  ): Promise<TrustedAudioProgramHandle> {
    if (!this.supported) fail("trusted_audio_program_unsupported");
    signal.throwIfAborted();
    if (!program || !Number.isSafeInteger(program.programEpoch) || program.programEpoch < 1
      || !Array.isArray(inputs) || inputs.length < 1 || inputs.length > 4
      || new Set(inputs.map(({ sourceId }) => sourceId)).size !== inputs.length
      || inputs.some(({ sourceId, sourceKind, stream }) => !SOURCE_ID.test(sourceId)
        || (sourceKind !== "microphone" && sourceKind !== "screen-audio")
        || !stream || typeof stream.getAudioTracks !== "function"
        || stream.getAudioTracks().length !== 1
        || stream.getAudioTracks()[0].readyState !== "live")
      || !Object.values(TRUSTED_AUDIO_PROGRAM_PROFILES).includes(profile)
      || (monitoringMode !== "off" && monitoringMode !== "headphones")) {
      fail("invalid_trusted_audio_program");
    }

    const context = new AudioContext({ latencyHint: "interactive", sampleRate: 48_000 });
    const mix = context.createGain();
    const limiter = context.createDynamicsCompressor();
    const outputMeter = context.createAnalyser();
    const destination = context.createMediaStreamDestination();
    const graphs = new Map<string, InputGraph>();
    let timer = 0;
    let closed = false;
    let monitorGain: GainNode | null = null;
    const levels: Record<string, number> = {};
    try {
      mix.gain.value = 1;
      mix.channelCount = profile.channelCount;
      mix.channelCountMode = "explicit";
      destination.channelCount = profile.channelCount;
      limiter.threshold.value = -3;
      limiter.knee.value = 3;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      outputMeter.fftSize = 512;
      outputMeter.smoothingTimeConstant = 0.7;
      mix.connect(limiter);
      limiter.connect(outputMeter);
      outputMeter.connect(destination);
      if (monitoringMode === "headphones") {
        monitorGain = context.createGain();
        monitorGain.gain.value = 0.65;
        limiter.connect(monitorGain);
        monitorGain.connect(context.destination);
      }
      for (const input of inputs) {
        const source = context.createMediaStreamSource(input.stream);
        const gain = context.createGain();
        const duck = context.createGain();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.65;
        const configuredGain = input.sourceKind === "microphone"
          ? profile.microphoneGain
          : profile.screenAudioGain;
        gain.gain.value = configuredGain;
        duck.gain.value = 1;
        source.connect(gain);
        gain.connect(analyser);
        analyser.connect(duck);
        duck.connect(mix);
        graphs.set(input.sourceId, {
          input, source, gain, duck, analyser,
          samples: new Float32Array(new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT)),
          track: input.stream.getAudioTracks()[0],
          ended: null,
          muted: false,
          configuredGain,
        });
      }
      if (context.state === "suspended") await context.resume();
      signal.throwIfAborted();
      const outputTracks = destination.stream.getAudioTracks();
      if (outputTracks.length !== 1 || outputTracks[0].readyState !== "live") {
        fail("trusted_audio_program_output_unavailable");
      }
      const track = outputTracks[0];
      try { track.contentHint = profile.priority === "screen-audio" ? "music" : "speech"; } catch { /* optional */ }
      const sample = () => {
        if (closed) return;
        let microphoneActive = false;
        for (const graph of graphs.values()) {
          const level = graph.muted ? 0 : sourceLevel(graph.analyser, graph.samples);
          levels[graph.input.sourceId] = level;
          if (graph.input.sourceKind === "microphone" && level >= profile.duckingThreshold) {
            microphoneActive = true;
          }
        }
        const duckTarget = profile.priority === "screen-audio" || !microphoneActive ? 1 : profile.duckingGain;
        for (const graph of graphs.values()) {
          if (graph.input.sourceKind === "screen-audio") {
            graph.duck.gain.setTargetAtTime(duckTarget, context.currentTime, 0.04);
          }
        }
      };
      timer = window.setInterval(sample, 50);

      const disconnect = (node: AudioNode) => {
        try { node.disconnect(); } catch { /* cleanup is idempotent */ }
      };
      const close = async () => {
        if (closed) return;
        closed = true;
        window.clearInterval(timer);
        for (const graph of graphs.values()) {
          if (graph.ended) graph.track.removeEventListener("ended", graph.ended);
          disconnect(graph.source);
          disconnect(graph.gain);
          disconnect(graph.analyser);
          disconnect(graph.duck);
        }
        graphs.clear();
        disconnect(mix);
        disconnect(limiter);
        disconnect(outputMeter);
        if (monitorGain) disconnect(monitorGain);
        if (track.readyState !== "ended") track.stop();
        if (context.state !== "closed") await context.close();
        for (const sourceId of Object.keys(levels)) delete levels[sourceId];
      };
      for (const [sourceId, graph] of graphs) {
        graph.ended = () => {
          if (closed || graphs.get(sourceId) !== graph) return;
          disconnect(graph.source);
          disconnect(graph.gain);
          disconnect(graph.analyser);
          disconnect(graph.duck);
          graphs.delete(sourceId);
          delete levels[sourceId];
          if (graphs.size === 0) void close();
        };
        graph.track.addEventListener("ended", graph.ended, { once: true });
      }
      const abort = () => { void close(); };
      signal.addEventListener("abort", abort, { once: true });
      return Object.freeze({
        outputSourceId: outputSourceId(),
        stream: destination.stream,
        track,
        snapshot: () => Object.freeze({
          profileId: profile.profileId,
          monitoringMode,
          sampleRate: context.sampleRate,
          channelCount: profile.channelCount,
          opusBitsPerSecond: profile.opusBitsPerSecond,
          aacBitsPerSecond: profile.aacBitsPerSecond,
          dtxRequested: profile.dtx,
          fecRequested: profile.fec,
          sourceLevels: Object.freeze({ ...levels }),
          peakLevel: Math.max(0, ...Object.values(levels)),
        }),
        setSourceMuted(sourceId: string, muted: boolean) {
          const graph = graphs.get(sourceId);
          if (!graph || typeof muted !== "boolean") fail("unknown_trusted_audio_source");
          graph.muted = muted;
          graph.gain.gain.setTargetAtTime(muted ? 0 : graph.configuredGain, context.currentTime, 0.015);
        },
        setSourceGain(sourceId: string, value: number) {
          const graph = graphs.get(sourceId);
          if (!graph) fail("unknown_trusted_audio_source");
          graph.configuredGain = boundedGain(value);
          if (!graph.muted) graph.gain.gain.setTargetAtTime(graph.configuredGain, context.currentTime, 0.015);
        },
        close: async () => {
          signal.removeEventListener("abort", abort);
          await close();
        },
      });
    } catch (error) {
      window.clearInterval(timer);
      for (const graph of graphs.values()) {
        try { graph.source.disconnect(); } catch { /* best effort */ }
        try { graph.gain.disconnect(); } catch { /* best effort */ }
        try { graph.analyser.disconnect(); } catch { /* best effort */ }
        try { graph.duck.disconnect(); } catch { /* best effort */ }
      }
      try { mix.disconnect(); } catch { /* best effort */ }
      try { limiter.disconnect(); } catch { /* best effort */ }
      try { outputMeter.disconnect(); } catch { /* best effort */ }
      try { monitorGain?.disconnect(); } catch { /* best effort */ }
      for (const track of destination.stream.getTracks()) if (track.readyState !== "ended") track.stop();
      try { if (context.state !== "closed") await context.close(); } catch { /* preserve setup error */ }
      throw error;
    }
  }
}

export const TRUSTED_AUDIO_PROGRAM_BUS_FACTORY = new InjectionToken<TrustedAudioProgramBusFactory>(
  "TRUSTED_AUDIO_PROGRAM_BUS_FACTORY",
  { providedIn: "root", factory: () => new BrowserTrustedAudioProgramBusFactory() },
);

@Injectable({ providedIn: "root" })
export class TrustedAudioProgramSettingsService {
  readonly profileId = signal<TrustedAudioProgramProfileId>("speech");
  readonly monitoringMode = signal<TrustedAudioMonitoringMode>("off");

  profile(): TrustedAudioProgramProfile {
    return TRUSTED_AUDIO_PROGRAM_PROFILES[this.profileId()];
  }

  setProfile(value: unknown): boolean {
    if (value !== "speech" && value !== "balanced" && value !== "music") return false;
    this.profileId.set(value);
    return true;
  }

  setMonitoring(value: unknown, trigger: unknown): boolean {
    if (trigger !== "user-action" || (value !== "off" && value !== "headphones")) return false;
    this.monitoringMode.set(value);
    return true;
  }
}
