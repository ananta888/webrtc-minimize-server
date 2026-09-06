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
const api = { ready: false, error: "", phase: "idle", captureCalls: 0, results: [] as object[] };
Object.assign(window, { __audioLifecycleGate: api });
const forbidden = async () => { api.captureCalls++; throw new Error("physical capture forbidden"); };
navigator.mediaDevices.getUserMedia = forbidden; navigator.mediaDevices.getDisplayMedia = forbidden;
const wait = async (condition: () => boolean) => {
  const deadline = performance.now() + 5000;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (!condition()) throw new Error("audio lifecycle condition timed out");
};
async function bounded(operation: () => Promise<void>, phase: string): Promise<void> {
  api.phase = phase;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("audio fixture operation timed out")), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
document.querySelector("button")!.addEventListener("click", async () => {
  try {
    for (const scenario of ["abort", "source-stop", "injected-pending-resume"]) {
      hangingResume = scenario === "injected-pending-resume";
      const source = new NativeContext(), oscillator = source.createOscillator(), destination = source.createMediaStreamDestination();
      const input = destination.stream.getAudioTracks()[0], controller = new AbortController();
      try {
        oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start();
        await bounded(() => source.resume(), `${scenario}:source-resume`);
        api.phase = `${scenario}:bus-create`;
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
          api.phase = `${scenario}:peak`;
          await wait(() => handle.snapshot().peakLevel > 0.01); peakObserved = true;
          if (scenario === "source-stop") input.stop(); else controller.abort();
          api.phase = `${scenario}:output-ended`;
          await wait(() => handle.track.readyState === "ended");
          await bounded(() => handle.close(), `${scenario}:bus-close`);
        }
        api.phase = `${scenario}:context-closed`;
        await wait(() => contexts.at(-1)!.state === "closed");
        api.results.push({ scenario, peakObserved, contextState: contexts.at(-1)!.state,
          outputState: outputs.at(-1)!.readyState, inputState: input.readyState, sourceContextState: source.state });
      } finally {
        controller.abort(); input.stop(); oscillator.stop(); oscillator.disconnect();
        // Keep the original failure phase even when the fixture's own cleanup also fails.
        const phase = api.phase;
        try { await bounded(() => source.close(), `${scenario}:source-close`); } finally { api.phase = phase; }
      }
    }
    api.phase = "complete"; api.ready = true;
  } catch { api.error = `audio_lifecycle_gate_failed:${api.phase}`; }
  finally {
    outputs.forEach(track => track.stop());
    await Promise.all(contexts.filter(context => context.state !== "closed")
      .map(context => bounded(() => context.close(), "final-cleanup").catch(() => {})));
  }
});
