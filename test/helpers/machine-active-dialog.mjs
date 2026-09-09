// Private synthetic controller only. Never joins, renews or grants permission.
export async function startActiveDialog({ sessionId, color }) {
  if (!["red", "green"].includes(color)) throw new Error("test_dialog_color_invalid");
  const api = window.anantaMachine;
  if (window.__activeDialog && !window.__activeDialog.stopped) throw new Error("test_dialog_already_running");
  const state = { stopped: false, samples: 0, nonzero: 0, sequence: 0, screenFrames: 0,
    audioClosed: false, screenClosed: false, failed: false, audioTimer: null, screenTimer: null,
    generation: 0, jpeg: "", inFlight: Promise.resolve(),
    async stop() {
      this.stopped = true; clearInterval(this.audioTimer); clearTimeout(this.screenTimer);
      await this.inFlight;
    } };
  window.__activeDialog = state;
  const source = api.audio.sources()[0];
  if (!source) throw new Error("test_dialog_audio_missing");
  await api.audio.open(source.publicationId, 10);
  api.chat.open();
  const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
  const drawing = canvas.getContext("2d");
  drawing.fillStyle = color === "red" ? "rgb(220,20,20)" : "rgb(20,220,20)";
  drawing.fillRect(0, 0, 640, 360);
  state.jpeg = canvas.toDataURL("image/jpeg", .7).split(",")[1]; canvas.width = canvas.height = 0;
  state.generation = api.screen.open("screen:" + sessionId).generation;
  state.audioTimer = setInterval(() => {
    try {
      const batch = api.audio.poll();
      for (const chunk of batch.chunks) {
        if (chunk.sequence !== ++state.sequence || chunk.startSample !== state.samples) {
          state.failed = true; throw new Error("test_dialog_pcm_order");
        }
        const bytes = Uint8Array.from(atob(chunk.pcmBase64), c => c.charCodeAt(0));
        const view = new DataView(bytes.buffer);
        state.samples += bytes.length / 2;
        for (let n = 0; n < bytes.length; n += 2) if (Math.abs(view.getInt16(n, true)) > 50) state.nonzero++;
        api.audio.ack(chunk.sequence);
      }
    } catch { state.audioClosed = true; clearInterval(state.audioTimer); }
  }, 50);
  const end = performance.now() + 15_000;
  const tick = () => {
    if (state.stopped) return;
    if (performance.now() >= end || state.screenFrames >= 65) { state.failed = true; return; }
    state.inFlight = api.screen.push(state.generation, state.screenFrames + 1, state.jpeg).then(() => {
      state.screenFrames++;
      if (!state.stopped) state.screenTimer = setTimeout(tick, 230);
    }, () => { state.screenClosed = true; });
  };
  tick();
}

export function activeDialogObservation() {
  const state = window.__activeDialog, api = window.anantaMachine;
  return { samples: state.samples, nonzero: state.nonzero, screenFrames: state.screenFrames,
    failed: state.failed, audioOpen: api.audio.status().open, audioCompleted: api.audio.status().completed, chatOpen: api.chat.status().open,
    screenOpen: api.screen.status().open, audioClosed: state.audioClosed, screenClosed: state.screenClosed };
}

export async function staleDialogDenied() {
  const api = window.anantaMachine, old = window.__activeDialog;
  await old.stop();
  let audio = false, chat = false, screen = false;
  try { api.audio.poll(); } catch { audio = true; }
  try { api.chat.poll(); } catch { chat = true; }
  try { await api.screen.push(old.generation, old.screenFrames + 1, old.jpeg); } catch { screen = true; }
  old.jpeg = "";
  return { audio, chat, screen };
}
