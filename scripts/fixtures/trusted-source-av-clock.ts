import { TrustedSourcePublisher } from "../../frontend/src/app/broadcast/trusted-source-publisher";
import { sameTrustedSource } from "../../frontend/src/app/broadcast/trusted-source-contract";
import { MediaE2eeController } from "../../frontend/src/app/webrtc/media-e2ee-controller";

// Browser-only esbuild entry, outside Node's test discovery tree.
// Explicit headless synthetic policy; no getUserMedia/getDisplayMedia or
// application source-approval shortcut. No frame keys cross the fixture bridge.
const fixture = window as any;
let context: AudioContext, oscillator: OscillatorNode, timer: ReturnType<typeof setInterval>;
let tracks: MediaStreamTrack[] = [], allowed = true;
const publishers = new Map<string, { publisher: TrustedSourcePublisher; lease: any; states: string[] }>();
const pending: any[] = [], lifetime = new AbortController();

fixture.createSyntheticAV = async () => {
  context = new AudioContext();
  const destination = context.createMediaStreamDestination(), gain = context.createGain();
  oscillator = context.createOscillator(); oscillator.frequency.value = 700;
  oscillator.connect(gain).connect(destination); gain.gain.value = 0;
  const pulseTimes: number[] = [];
  let time = context.currentTime + 0.5;
  for (let i = 0; i < 60; i++) {
    pulseTimes.push(time);
    gain.gain.setValueAtTime(0.1, time);
    gain.gain.setValueAtTime(0, time + 0.16);
    time += [0.41, 0.73, 0.53, 0.89][i % 4];
  }
  oscillator.start(); await context.resume();
  const canvas = document.querySelector("canvas")!, draw = canvas.getContext("2d")!;
  timer = setInterval(() => {
    const now = context.currentTime;
    draw.fillStyle = pulseTimes.some(at => now >= at && now < at + 0.16) ? "red" : "blue";
    draw.fillRect(0, 0, 320, 180);
  }, 10);
  tracks = [canvas.captureStream(30).getVideoTracks()[0], destination.stream.getAudioTracks()[0]];
  return { sources: tracks.map((track, i) => ({ codec: i === 0 ? "video/vp8" : "audio/opus", publicationId: track.id })) };
};

fixture.acceptSourceNativeAV = async (value: any) => {
  const id = value.fixture === "lease" ? value.lease.sourceLeaseId : value.sourceLeaseId;
  const entry = publishers.get(id);
  if (!entry) { if (pending.length >= 64) throw new Error("AV fixture queue"); pending.push(value); return; }
  if (value.fixture === "lease") entry.publisher.renew(value.lease);
  else {
    const { type, ...fields } = value;
    await entry.publisher.receiveSignal({ ...fields, type: "trusted-source-agent-signal",
      packagerId: entry.lease.consent.granteePackagerRef, packagerDeviceRef: entry.lease.consent.granteeDeviceRef });
  }
};

fixture.startSourceAV = async (leases: any[]) => {
  for (let i = 0; i < leases.length; i++) {
    const lease = leases[i], track = tracks[i], states: string[] = [];
    const publisher = await TrustedSourcePublisher.start(lease, track, {}, {
      signal: lifetime.signal,
      authorized: current => allowed && track.readyState === "live" && sameTrustedSource(lease, current),
      sendSignal: value => { void fixture.sendSourceNativeAV(value); },
      onState: state => { if (states.length < 32) states.push(state); },
      createEncryption: fail => new MediaE2eeController(() => fail(), () => fail()),
    });
    publishers.set(lease.sourceLeaseId, { publisher, lease, states });
    const saved = pending.splice(0);
    for (const message of saved) await fixture.acceptSourceNativeAV(message);
  }
};

fixture.sourceAVObservation = () => ({ states: [...publishers.values()].map(entry => entry.states), tracks: tracks.map(track => track.readyState) });
fixture.cleanupSourceAV = async () => {
  allowed = false; lifetime.abort();
  for (const entry of publishers.values()) entry.publisher.stop();
  publishers.clear(); pending.length = 0;
  for (const track of tracks) track.stop();
  clearInterval(timer); oscillator?.stop(); await context?.close();
};
