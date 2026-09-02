import { Injectable } from "@angular/core";

export interface CaptionAudioGraph {
  readonly sampleRate: number;
  close(): Promise<void>;
}

export type CaptionPcmConsumer = (samples: Float32Array, sampleRate: number) => void;

@Injectable({ providedIn: "root" })
export class CaptionAudioGraphFactory {
  supported(): boolean {
    return typeof AudioContext !== "undefined"
      && typeof AudioWorkletNode !== "undefined"
      && "audioWorklet" in AudioContext.prototype;
  }

  async connect(track: MediaStreamTrack, consume: CaptionPcmConsumer): Promise<CaptionAudioGraph> {
    if (!this.supported() || track.kind !== "audio" || track.readyState !== "live") {
      throw new Error("AudioWorklet oder ein aktives Mikrofon ist in diesem Browser nicht verfügbar.");
    }
    const clone = track.clone();
    const context = new AudioContext({ latencyHint: "interactive" });
    let source: MediaStreamAudioSourceNode | null = null;
    let collector: AudioWorkletNode | null = null;
    let silentOutput: GainNode | null = null;
    let closed = false;
    try {
      await context.audioWorklet.addModule("/assets/vosk-audio.worklet.js");
      source = context.createMediaStreamSource(new MediaStream([clone]));
      collector = new AudioWorkletNode(context, "vosk-pcm-collector-v1", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      silentOutput = context.createGain();
      silentOutput.gain.value = 0;
      collector.port.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (!(data instanceof ArrayBuffer) || data.byteLength !== 4096 * Float32Array.BYTES_PER_ELEMENT) return;
        consume(new Float32Array(data), context.sampleRate);
      };
      source.connect(collector);
      collector.connect(silentOutput);
      silentOutput.connect(context.destination);
      await context.resume();
    } catch (error) {
      clone.stop();
      try { source?.disconnect(); } catch { /* already detached */ }
      try { collector?.disconnect(); } catch { /* already detached */ }
      try { silentOutput?.disconnect(); } catch { /* already detached */ }
      await context.close().catch(() => undefined);
      throw error;
    }
    return {
      sampleRate: context.sampleRate,
      close: async () => {
        if (closed) return;
        closed = true;
        if (collector) {
          collector.port.onmessage = null;
          collector.port.close();
        }
        try { source?.disconnect(); } catch { /* already detached */ }
        try { collector?.disconnect(); } catch { /* already detached */ }
        try { silentOutput?.disconnect(); } catch { /* already detached */ }
        clone.stop();
        await context.close().catch(() => undefined);
      },
    };
  }
}
