import "@angular/compiler";
import { BrowserTrustedAudioProgramBusFactory, TRUSTED_AUDIO_PROGRAM_PROFILES } from "../../frontend/src/app/broadcast/trusted-audio-program-bus";

const NativeContext = window.AudioContext;
const contexts: AudioContext[] = [], outputs: MediaStreamTrack[] = [];
let hangingResume = false;
class ObservedContext extends NativeContext {
  constructor(options?: AudioContextOptions) { super(options); contexts.push(this); }
  override get state(): AudioContextState { return hangingResume && super.state !== "closed" ? "suspended" : super.state; }
  override resume(): Promise<void> { return hangingResume ? new Promise(() => {}) : super.resume(); }
  override createMediaStreamDestination(): MediaStreamAudioDestinationNode {
    const node = super.createMediaStreamDestination(); outputs.push(...node.stream.getTracks()); return node;
  }
}
window.AudioContext = ObservedContext;
const api = { ready: false, error: "", captureCalls: 0, results: [] as object[] };
Object.assign(window, { __audioLifecycleGate: api });
const forbidden = async () => { api.captureCalls++; throw new Error("physical capture forbidden"); };
navigator.mediaDevices.getUserMedia = forbidden; navigator.mediaDevices.getDisplayMedia = forbidden;
const wait = async (condition: () => boolean) => {
  const deadline = performance.now() + 5000;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (!condition()) throw new Error("audio lifecycle condition timed out");
};
document.querySelector("button")!.addEventListener("click", async () => {
  try {
    for (const scenario of ["abort", "source-stop", "injected-pending-resume"]) {
      hangingResume = scenario === "injected-pending-resume";
      const source = new NativeContext(), oscillator = source.createOscillator(), destination = source.createMediaStreamDestination();
      oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start(); await source.resume();
      const input = destination.stream.getAudioTracks()[0], controller = new AbortController();
      try {
        const promise = new BrowserTrustedAudioProgramBusFactory().create({ tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "synthetic-room",
          programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 1, programEpoch: 1 },
          [{ sourceId: "src_microphoneaaaaaa", sourceKind: "microphone", stream: destination.stream }],
          TRUSTED_AUDIO_PROGRAM_PROFILES.speech, "off", controller.signal);
        let peakObserved = false;
        if (hangingResume) {
          controller.abort();
          if (await promise.then(() => false, () => true) !== true) throw new Error("pending setup escaped abort");
        } else {
          const handle = await promise;
          await wait(() => handle.snapshot().peakLevel > 0.01); peakObserved = true;
          if (scenario === "source-stop") input.stop(); else controller.abort();
          await wait(() => handle.track.readyState === "ended"); await handle.close();
        }
        await wait(() => contexts.at(-1)!.state === "closed");
        api.results.push({ scenario, peakObserved, contextState: contexts.at(-1)!.state,
          outputState: outputs.at(-1)!.readyState, inputState: input.readyState, sourceContextState: source.state });
      } finally {
        controller.abort(); input.stop(); oscillator.stop(); oscillator.disconnect(); await source.close();
      }
    }
    api.ready = true;
  } catch { api.error = "audio_lifecycle_gate_failed"; }
  finally { for (const context of contexts) if (context.state !== "closed") await context.close(); outputs.forEach(track => track.stop()); }
});
