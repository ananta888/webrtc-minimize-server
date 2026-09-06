import "@angular/compiler";
import { BrowserTrustedVideoCompositorFactory, TRUSTED_VIDEO_PROFILES, TrustedVideoProgramSettingsService,
  TrustedVideoCompositorHandle, TrustedVideoLayout } from "../../frontend/src/app/broadcast/trusted-video-compositor";

const ids = ["src_cameraaaaaaaaaaa", "src_screenaaaaaaaaaa", "src_camerabbbbbbbbbb"];
const inputs: MediaStream[] = [];
let handle: TrustedVideoCompositorHandle | undefined, timer = 0, counter = 0, frameCallback = 0;
let frames = 0, lastMediaTime = -1, backwards = 0;
const output = document.createElement("video"); output.muted = true; output.playsInline = true;
const probe = document.createElement("canvas"); probe.width = 960; probe.height = 540;
const probeContext = probe.getContext("2d", { willReadFrequently: true })!;
const controller = new AbortController();
const canvases = [document.createElement("canvas"), document.createElement("canvas"), document.createElement("canvas")];
canvases.forEach((canvas, index) => { canvas.width = index === 0 ? 200 : 400; canvas.height = 300; });
const draw = () => {
  counter++;
  canvases.forEach((canvas, index) => {
    const context = canvas.getContext("2d")!;
    context.fillStyle = ["#ff0000", "#00ff00", "#0000ff"][index]; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, 20);
    context.fillRect(counter % (canvas.width - 20), 280, 20, 20);
  });
};
const observe = (_now: number, metadata: VideoFrameCallbackMetadata) => {
  if (metadata.mediaTime < lastMediaTime) backwards++;
  lastMediaTime = metadata.mediaTime; frames++;
  frameCallback = output.requestVideoFrameCallback(observe);
};
const api = {
  ready: false, error: "", captureCalls: 0,
  stats: () => ({ ...handle?.snapshot(), outputState: handle?.track.readyState, frames, lastMediaTime, backwards }),
  layout: (layout: TrustedVideoLayout, active = "") => handle!.setLayout(layout, active),
  overlay: (enabled: boolean) => handle!.setOverlay({ ...new TrustedVideoProgramSettingsService().overlay(),
    showProgramTitle: enabled, programTitle: "VISIBLE ONLY WITH CONSENT" }),
  pixels: (points: number[][]) => {
    probeContext.drawImage(output, 0, 0, 960, 540);
    return points.map(([x, y]) => [...probeContext.getImageData(x, y, 1, 1).data].slice(0, 3));
  },
  hash: () => {
    probeContext.drawImage(output, 0, 0, 960, 540);
    let result = 2166136261;
    for (const byte of probeContext.getImageData(0, 0, 960, 540).data) result = Math.imul(result ^ byte, 16777619) >>> 0;
    return result;
  },
  endInput: (index: number) => inputs[index].getTracks().forEach(track => track.stop()),
  close: async () => {
    controller.abort(); await handle?.close(); clearInterval(timer);
    if (frameCallback) output.cancelVideoFrameCallback(frameCallback);
    output.pause(); output.srcObject = null;
    inputs.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    return { outputState: handle?.track.readyState, inputStates: inputs.flatMap(stream => stream.getTracks().map(track => track.readyState)), frames };
  },
};
Object.assign(window, { __compositorGate: api });
const denied = async () => { api.captureCalls++; throw new Error("No physical capture in synthetic compositor gate"); };
navigator.mediaDevices.getUserMedia = denied; navigator.mediaDevices.getDisplayMedia = denied;
document.querySelector("button")!.addEventListener("click", async () => {
  try {
    draw(); timer = window.setInterval(draw, 33);
    inputs.push(...canvases.map(canvas => canvas.captureStream(30)));
    handle = await new BrowserTrustedVideoCompositorFactory().create({ tenantId: "tn_aaaaaaaaaaaaaaaa", roomId: "synthetic-room",
      programId: "prg_aaaaaaaaaaaaaaaa", programRevision: 1, programEpoch: 1 },
      inputs.map((stream, index) => ({ stream, sourceId: ids[index], sourceKind: index === 1 ? "screen" : "camera" })),
      TRUSTED_VIDEO_PROFILES.bandwidth, "single", new TrustedVideoProgramSettingsService().overlay(), controller.signal);
    output.srcObject = handle.stream; await output.play();
    frameCallback = output.requestVideoFrameCallback(observe); api.ready = true;
  } catch { api.error = "compositor_gate_start_failed"; await api.close(); }
});
