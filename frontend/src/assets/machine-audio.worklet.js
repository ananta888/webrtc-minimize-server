// One unacknowledged 100ms mono PCM16LE chunk. AudioContext owns resampling.
class MachineAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new ArrayBuffer(3200); this.view = new DataView(this.buffer);
    this.offset = 0; this.start = 0; this.pending = -1; this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type === "stop") { this.stop(); return; }
      if (data?.type !== "ack" || Object.keys(data).length !== 2 || data.startSample !== this.pending || this.pending < 0) {
        this.stop("meet_audio_ack_invalid"); return;
      }
      this.pending = -1;
    };
  }
  stop(code = "") {
    if (this.stopped) return;
    this.stopped = true; new Uint8Array(this.buffer).fill(0);
    if (code) this.port.postMessage({ type: "error", code });
  }
  process(inputs) {
    if (this.stopped) return false;
    if (sampleRate !== 16000) { this.stop("meet_audio_rate_unsupported"); return false; }
    const channels = inputs[0];
    if (!channels?.length) return true;
    if (channels.length !== 1) { this.stop("meet_audio_channels_invalid"); return false; }
    for (const sample of channels[0]) {
      if (!Number.isFinite(sample)) { this.stop("meet_audio_sample_invalid"); return false; }
      const clipped = Math.max(-1, Math.min(1, sample));
      this.view.setInt16(this.offset * 2, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
      if (++this.offset !== 1600) continue;
      if (this.pending >= 0) { this.stop("meet_audio_backpressure"); return false; }
      const pcm = this.buffer;
      this.pending = this.start;
      this.port.postMessage({ type: "pcm", startSample: this.start, pcm }, [pcm]);
      this.start += 1600; this.offset = 0;
      this.buffer = new ArrayBuffer(3200); this.view = new DataView(this.buffer);
    }
    return true;
  }
}
registerProcessor("ananta-machine-pcm-v1", MachineAudioProcessor);
