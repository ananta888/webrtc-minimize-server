// Private synthetic PCM sink; no capture, decoder, model, network or room policy.
class MachineSpeechProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions: options } = {}) {
    super();
    this.queue = []; this.received = 0; this.played = 0; this.pending = 0;
    this.stopped = false; this.started = false;
    this.total = options?.totalSamples;
    // AudioContext.currentTime may already advance before this worklet's first
    // quantum. Own the relative audio budget here; the source owns wall/lease time.
    const budget = options?.budgetFrames;
    this.expires = currentFrame + budget;
    if (!options || Object.keys(options).sort().join() !== "budgetFrames,totalSamples"
      || sampleRate !== 22050 || !Number.isSafeInteger(this.total) || this.total < 1 || this.total > 882000
      || !Number.isSafeInteger(budget) || budget < 1 || budget > 50 * 22050) {
      this.stop("meet_speech_worklet_profile_invalid");
    }
    this.port.onmessage = ({ data }) => this.accept(data);
  }
  stop(code = "") {
    if (this.stopped) return;
    this.stopped = true;
    for (const item of this.queue) new Uint8Array(item.pcm).fill(0);
    this.queue.length = 0; this.pending = 0;
    if (code) this.port.postMessage({ type: "error", code });
  }
  accept(data) {
    if (this.stopped) { if (data?.pcm instanceof ArrayBuffer) new Uint8Array(data.pcm).fill(0); return; }
    if (data?.type === "stop" && Object.keys(data).length === 1) { this.stop(); return; }
    if (data?.type !== "pcm" || Object.keys(data).sort().join() !== "pcm,startSample,type"
      || data.startSample !== this.received || !(data.pcm instanceof ArrayBuffer)
      || !data.pcm.byteLength || data.pcm.byteLength % 2 || data.pcm.byteLength > 882
      || data.pcm.byteLength / 2 !== Math.min(441, this.total - this.received)
      || this.received + data.pcm.byteLength / 2 > this.total
      || this.pending + data.pcm.byteLength / 2 > 4410 || this.queue.length >= 10) {
      if (data?.pcm instanceof ArrayBuffer) new Uint8Array(data.pcm).fill(0);
      this.stop("meet_speech_worklet_input_invalid"); return;
    }
    const samples = data.pcm.byteLength / 2;
    this.queue.push({ pcm: data.pcm, view: new DataView(data.pcm), offset: 0, samples });
    this.received += samples; this.pending += samples;
  }
  process(_inputs, outputs) {
    const channels = outputs[0];
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.stopped) return false;
    if (channels?.length !== 1 || outputs.length !== 1 || currentFrame + channels[0].length >= this.expires) {
      this.stop("meet_speech_worklet_expired_or_invalid"); return false;
    }
    if (!this.started && this.pending < Math.min(2205, this.total)) return true;
    this.started = true;
    for (let index = 0; index < channels[0].length; index++) {
      const item = this.queue[0];
      if (!item) {
        if (this.played !== this.total) { channels[0].fill(0); this.stop("meet_speech_worklet_underrun"); }
        else this.stop();
        return false;
      }
      channels[0][index] = item.view.getInt16(item.offset * 2, true) / 32768;
      item.view.setInt16(item.offset * 2, 0, true);
      item.offset++; this.played++; this.pending--;
      if (item.offset === item.samples) {
        this.queue.shift();
        this.port.postMessage({ type: "progress", playedSamples: this.played });
      }
    }
    return true;
  }
}
registerProcessor("ananta-machine-speech-v1", MachineSpeechProcessor);
