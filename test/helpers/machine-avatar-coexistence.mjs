// Closed synthetic source producer, installed only in the private browser test.
// No device capture, model, arbitrary URL or production endpoint.
export async function startAvatarCompanions(sessionId) {
  const machine = window.anantaMachine;
  const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
  const drawing = canvas.getContext("2d"); drawing.fillStyle = "rgb(20,220,20)"; drawing.fillRect(0, 0, 640, 360);
  const jpeg = canvas.toDataURL("image/jpeg", .7).split(",")[1]; canvas.width = canvas.height = 0;
  const screen = machine.screen.open("screen:" + sessionId);
  const state = { closed: false, failed: false, speechDone: false };
  window.__avatarCompanions = state;
  const screenLoop = (async () => {
    let sequence = 0; const end = Date.now() + 20_000;
    while (!state.closed && Date.now() < end) {
      await machine.screen.push(screen.generation, ++sequence, jpeg);
      await new Promise(resolve => setTimeout(resolve, 220));
    }
  })();
  screenLoop.catch(() => { if (!state.closed) state.failed = true; });
  const speechLoop = (async () => {
    const lease = await machine.speech.open("speech:" + sessionId, 22050 * 15);
    let offset = 0; const end = Date.now() + 20_000;
    while (!state.closed && Date.now() < end) {
      const current = machine.speech.status();
      if (current.state === "completed") { state.speechDone = true; return; }
      if (current.state !== "open") throw new Error("test_companion_speech_closed");
      while (offset < lease.totalSamples && offset - current.playedSamples + 441 <= lease.queueSamples) {
        const bytes = new Uint8Array(882), view = new DataView(bytes.buffer);
        for (let n = 0; n < 441; n++) view.setInt16(n * 2, Math.round(12000 * Math.sin(2 * Math.PI * 440 * (offset + n) / 22050)), true);
        machine.speech.push(lease.generation, offset, btoa(String.fromCharCode(...bytes))); offset += 441;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  })();
  speechLoop.catch(() => { if (!state.closed) state.failed = true; });
  state.close = async () => {
    state.closed = true; machine.speech.close(); machine.screen.close();
    await Promise.allSettled([screenLoop, speechLoop]);
  };
}

export function decodedAvatar() {
  const video = [...document.querySelectorAll("video")].find(v => v.videoWidth === 256 && v.videoHeight === 256);
  if (!video) return null;
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
  const drawing = canvas.getContext("2d"); drawing.drawImage(video, 0, 0);
  const center = [...drawing.getImageData(128, 105, 1, 1).data];
  const label = drawing.getImageData(20, 180, 216, 30).data;
  let white = 0; for (let i = 0; i < label.length; i += 4) if (label[i] > 200 && label[i + 1] > 200 && label[i + 2] > 200) white++;
  const indicator = drawing.getImageData(28, 224, 200, 1).data;
  let bright = 0; for (let i = 0; i < indicator.length; i += 4) if (indicator[i + 1] > 150) bright++;
  canvas.width = canvas.height = 0;
  return white > 100 ? { center, white, bright } : null;
}

export function decodedGreenScreen() {
  const video = [...document.querySelectorAll("video")].find(v => v.videoWidth === 640 && v.videoHeight === 360);
  if (!video) return false;
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const drawing = canvas.getContext("2d"); drawing.drawImage(video, 0, 0, 1, 1);
  const pixel = drawing.getImageData(0, 0, 1, 1).data; canvas.width = canvas.height = 0;
  return pixel[0] < 80 && pixel[1] > 150 && pixel[2] < 80;
}
