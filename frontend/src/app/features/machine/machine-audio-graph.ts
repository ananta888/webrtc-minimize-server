import { Injectable } from "@angular/core";

export interface MachineAudioGraph { close(): Promise<void> }
export type MachinePcmConsumer = (startSample: number, pcm: ArrayBuffer) => void;

async function untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop: () => void = () => {};
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      stop = () => reject(new Error("meet_audio_cancelled")); signal.addEventListener("abort", stop, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", stop); }
}

@Injectable({ providedIn: "root" })
export class MachineAudioGraphFactory {
  supported(): boolean { return typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined"; }
  async connect(track: MediaStreamTrack, consume: MachinePcmConsumer, failed: () => void, signal: AbortSignal): Promise<MachineAudioGraph> {
    if (!this.supported() || track.kind !== "audio" || track.readyState !== "live" || track.muted || !track.enabled) {
      throw new Error("meet_audio_source_unavailable");
    }
    signal.throwIfAborted();
    const clone = track.clone();
    // Chromium's remote-audio decoder needs a playout consumer before a cloned
    // WebAudio source yields samples. This private, silent sink is not capture
    // and never feeds the outgoing microphone or the room mix.
    const sink = document.createElement("audio");
    sink.volume = 0; sink.srcObject = new MediaStream([clone]);
    let context: AudioContext | null = null, collector: AudioWorkletNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null, output: GainNode | null = null, closed = false;
    const close = async () => {
      if (closed) return; closed = true; signal.removeEventListener("abort", aborted);
      if (collector) { collector.port.onmessage = null; collector.port.postMessage({ type: "stop" }); collector.port.close(); }
      sink.pause(); sink.srcObject = null; sink.removeAttribute("src"); sink.load();
      try { source?.disconnect(); collector?.disconnect(); output?.disconnect(); } catch { /* Closing is idempotent. */ }
      clone.stop(); await context?.close().catch(() => undefined);
    };
    const aborted = () => { void close(); };
    signal.addEventListener("abort", aborted, { once: true });
    try {
      // The browser resamples the decrypted MediaStream into this real context rate.
      context = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
      if (context.sampleRate !== 16000) throw new Error("meet_audio_rate_unsupported");
      await untilAbort(sink.play(), signal); signal.throwIfAborted();
      await untilAbort(context.audioWorklet.addModule("/assets/machine-audio.worklet.js"), signal); signal.throwIfAborted();
      source = context.createMediaStreamSource(new MediaStream([clone]));
      collector = new AudioWorkletNode(context, "ananta-machine-pcm-v1", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit" });
      output = context.createGain(); output.gain.value = 0;
      collector.port.onmessage = ({ data }) => {
        if (closed || signal.aborted) return;
        if (data?.type !== "pcm" || Object.keys(data).length !== 3 || !Number.isSafeInteger(data.startSample)
          || data.startSample < 0 || !(data.pcm instanceof ArrayBuffer) || data.pcm.byteLength !== 3200) {
          failed(); void close(); return;
        }
        try {
          consume(data.startSample, data.pcm);
          if (!closed && !signal.aborted) collector!.port.postMessage({ type: "ack", startSample: data.startSample });
        } catch { failed(); void close(); }
      };
      source.connect(collector); collector.connect(output); output.connect(context.destination);
      await untilAbort(context.resume(), signal); signal.throwIfAborted();
      if (context.state !== "running") throw new Error("meet_audio_context_unavailable");
      return { close };
    } catch (error) { await close(); throw error; }
  }
}
