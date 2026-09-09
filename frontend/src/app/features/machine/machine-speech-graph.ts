import { Injectable } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { untilAudioAbort } from "./machine-audio-operation";
import { MachinePublicationOwnership } from "./machine-publication-ownership";
import { MachineSpeechGraph, SPEECH_RATE } from "./machine-speech-source";
import { MachineMediaTimingService } from "./machine-media-timing.service";
import { SourceTimingLease } from "./machine-media-timeline";

@Injectable()
export class MachineSpeechGraphFactory {
  constructor(private readonly mesh: PeerMeshService, private readonly ownership: MachinePublicationOwnership,
    private readonly timing: MachineMediaTimingService) {}

  async create(totalSamples: number, expiresAt: number, progress: (played: number) => void,
    failed: () => void, signal: AbortSignal): Promise<MachineSpeechGraph> {
    signal.throwIfAborted();
    if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") throw new Error("meet_speech_unsupported");
    const claim = this.ownership.claim(["microphone"]);
    let context: AudioContext | null = null, node: AudioWorkletNode | null = null;
    let output: MediaStreamAudioDestinationNode | null = null, quiet: GainNode | null = null;
    let closed = false, attached = false;
    let timing: SourceTimingLease | undefined;
    // Every owned resource is released even if another browser cleanup API throws.
    const release = (action: () => void) => { try { action(); } catch { /* Already closing; never revive this generation. */ } };
    const close = () => {
      if (closed) return; closed = true; signal.removeEventListener("abort", close);
      timing?.close();
      if (node) {
        node.port.onmessage = null; node.onprocessorerror = null;
        release(() => node!.port.postMessage({ type: "stop" })); release(() => node!.port.close());
      }
      release(() => node?.disconnect()); release(() => quiet?.disconnect());
      output?.stream.getTracks().forEach(track => release(() => track.stop()));
      if (attached && claim.owns("microphone")) release(() => this.mesh.detachPublication("microphone"));
      claim.release(); release(() => { void context?.close().catch(() => undefined); });
    };
    const fail = () => { if (!closed) { try { failed(); } finally { close(); } } };
    signal.addEventListener("abort", close, { once: true });
    try {
      timing = this.timing.open("speech", "pcm-progress", fail);
      context = new AudioContext({ sampleRate: SPEECH_RATE, latencyHint: "interactive" });
      if (context.sampleRate !== SPEECH_RATE) throw new Error("meet_speech_rate_unsupported");
      await untilAudioAbort(context.audioWorklet.addModule("/assets/machine-speech.worklet.js"), signal);
      signal.throwIfAborted();
      const seconds = Math.min(50, (expiresAt - Date.now()) / 1000);
      if (seconds <= 0) throw new Error("meet_speech_expired");
      node = new AudioWorkletNode(context, "ananta-machine-speech-v1", {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { totalSamples, budgetFrames: Math.floor(seconds * SPEECH_RATE) },
      });
      output = context.createMediaStreamDestination();
      const tracks = output.stream.getTracks();
      if (tracks.length !== 1 || tracks[0].kind !== "audio") throw new Error("meet_speech_track_invalid");
      // A silent local render branch drives the clock; no microphone, speaker mix or remote input is consumed.
      quiet = context.createGain(); quiet.gain.value = 0;
      node.connect(output); node.connect(quiet); quiet.connect(context.destination);
      node.port.onmessage = ({ data }) => {
        if (closed || signal.aborted) return;
        if (data?.type !== "progress" || Object.keys(data).sort().join() !== "playedSamples,type"
          || !Number.isSafeInteger(data.playedSamples)) { fail(); return; }
        try {
          timing!.observe(Math.floor(data.playedSamples * 1_000_000 / SPEECH_RATE));
          progress(data.playedSamples);
        } catch { fail(); }
      };
      node.onprocessorerror = fail;
      attached = true; this.mesh.attachPublication("microphone", output.stream);
      await untilAudioAbort(context.resume(), signal); signal.throwIfAborted();
      if (context.state !== "running") throw new Error("meet_speech_context_unavailable");
      while (!this.mesh.localPublicationProtected(tracks[0]) || !this.mesh.overlayReady()) {
        await untilAudioAbort(new Promise(resolve => setTimeout(resolve, 50)), signal);
      }
      signal.throwIfAborted();
      return { close, push: (startSample, pcm) => {
        if (closed || signal.aborted || !claim.owns("microphone") || context!.state !== "running") throw new Error("meet_speech_closed");
        node!.port.postMessage({ type: "pcm", startSample, pcm }, [pcm]);
      } };
    } catch (error) { close(); throw error; }
  }
}
