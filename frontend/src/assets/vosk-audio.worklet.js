class VoskPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 4096;
    this.chunk = new Float32Array(this.chunkSize);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;
    let sourceOffset = 0;
    while (sourceOffset < channel.length) {
      const length = Math.min(channel.length - sourceOffset, this.chunkSize - this.offset);
      this.chunk.set(channel.subarray(sourceOffset, sourceOffset + length), this.offset);
      this.offset += length;
      sourceOffset += length;
      if (this.offset === this.chunkSize) {
        const complete = this.chunk;
        this.port.postMessage(complete.buffer, [complete.buffer]);
        this.chunk = new Float32Array(this.chunkSize);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("vosk-pcm-collector-v1", VoskPcmProcessor);
