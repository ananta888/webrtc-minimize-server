import { InjectionToken } from "@angular/core";

export interface BroadcastAudioMeter {
  close(): Promise<void>;
}

export interface BroadcastAudioMeterFactory {
  readonly supported: boolean;
  create(stream: MediaStream, listener: (level: number) => void): Promise<BroadcastAudioMeter>;
}

export class BrowserBroadcastAudioMeterFactory implements BroadcastAudioMeterFactory {
  readonly supported = typeof AudioContext === "function";

  async create(stream: MediaStream, listener: (level: number) => void): Promise<BroadcastAudioMeter> {
    if (!this.supported) throw new Error("broadcast_audio_meter_unsupported");
    const context = new AudioContext({ latencyHint: "interactive" });
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    let loopStopped = false;
    let sourceDisconnected = false;
    let analyserDisconnected = false;
    let contextClosed = false;
    const update = () => {
      if (loopStopped) return;
      analyser.getByteTimeDomainData(samples);
      let squareSum = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        squareSum += normalized * normalized;
      }
      listener(Math.min(1, Math.sqrt(squareSum / samples.length) * 4));
      frame = requestAnimationFrame(update);
    };
    const meter: BroadcastAudioMeter = {
      async close() {
        const errors: unknown[] = [];
        if (!loopStopped) {
          loopStopped = true;
          cancelAnimationFrame(frame);
          try { listener(0); } catch { /* a UI listener cannot block media cleanup */ }
        }
        if (!sourceDisconnected) {
          try {
            source.disconnect();
            sourceDisconnected = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (!analyserDisconnected) {
          try {
            analyser.disconnect();
            analyserDisconnected = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (!contextClosed) {
          try {
            if (context.state !== "closed") await context.close();
            contextClosed = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) throw errors[0];
      },
    };
    try {
      if (context.state === "suspended") await context.resume();
      frame = requestAnimationFrame(update);
      return meter;
    } catch (error) {
      try { await meter.close(); } catch { /* preserve the setup failure */ }
      throw error;
    }
  }
}

export const BROADCAST_AUDIO_METER_FACTORY = new InjectionToken<BroadcastAudioMeterFactory>(
  "BROADCAST_AUDIO_METER_FACTORY",
  {
    providedIn: "root",
    factory: () => new BrowserBroadcastAudioMeterFactory(),
  },
);
