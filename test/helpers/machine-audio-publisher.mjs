import fs from "node:fs/promises";
import { waitFixtureValue } from "./machine-browser-wait.mjs";

/** A bounded local synthetic WAV, never a physical microphone or remote URL. */
export async function startSyntheticAudioPublisher(page, source, file) {
  if (!["microphone", "screen-audio"].includes(source)) throw new Error("test_audio_source_invalid");
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 44 || stat.size > 400000) throw new Error("test_audio_fixture_invalid");
  const bytes = await fs.readFile(file);
  if (bytes.length !== stat.size || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("test_audio_fixture_invalid");
  try {
    await page.evaluate(({ source, wav }) => {
      const capture = async () => {
        const bytes = Uint8Array.from(atob(wav), c => c.charCodeAt(0));
        const audio = new AudioContext();
        let stream;
        try {
          const decoded = await audio.decodeAudioData(bytes.buffer);
          if (decoded.duration < 1 || decoded.duration > 8 || decoded.numberOfChannels !== 1) throw new Error("test_audio_fixture_invalid");
          const player = audio.createBufferSource(), destination = audio.createMediaStreamDestination();
          player.buffer = decoded; player.connect(destination);
          stream = destination.stream;
          if (source === "screen-audio") {
            const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
            const context = canvas.getContext("2d"); context.fillStyle = "#224466"; context.fillRect(0, 0, 320, 180);
            const video = canvas.captureStream(1).getVideoTracks()[0]; stream.addTrack(video);
            video.addEventListener("ended", () => { canvas.width = canvas.height = 0; });
          }
          let spoken = false;
          window.__startSyntheticReceiveSpeech = () => {
            if (spoken || audio.state === "closed") throw new Error("test_audio_speech_already_started");
            spoken = true; player.start(audio.currentTime + 1);
          };
          for (const track of stream.getTracks()) track.addEventListener("ended", () => {
            window.__startSyntheticReceiveSpeech = null;
            if (spoken) player.stop(); void audio.close();
          });
          await audio.resume();
          return stream;
        } catch (error) { stream?.getTracks().forEach(track => track.stop()); await audio.close(); throw error; }
      };
      if (source === "microphone") navigator.mediaDevices.getUserMedia = capture;
      else navigator.mediaDevices.getDisplayMedia = capture;
    }, { source, wav: bytes.toString("base64") });
  } finally { bytes.fill(0); }
  if (source === "screen-audio") {
    await page.locator(".nav-item", { hasText: "Einstellungen" }).click();
    await page.locator("#screen-audio-enabled").check();
    await page.locator(".nav-item", { hasText: /^Live$/ }).click();
  }
  const toggle = source === "microphone" ? "microphone" : "screen";
  await page.locator(`#toggle-${toggle}`).click();
  await page.locator(`#toggle-${toggle}[aria-pressed="true"]`).waitFor();
}

export async function grantSyntheticAudioPublisher(page, source) {
  if (!["microphone", "screen-audio"].includes(source)) throw new Error("test_audio_source_invalid");
  await page.locator(".nav-item", { hasText: "Analyse" }).click();
  const panel = page.locator("app-machine-permissions-panel");
  await panel.getByText("Keine Empfangsfreigabe erteilt.", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Für diese KI einstellen" }).click();
  await waitFixtureValue(page, () => [...document.querySelectorAll("app-machine-permissions-panel fieldset input[type=checkbox]")]
    .every(input => !input.checked));
  await panel.getByLabel(source === "microphone" ? "Mein laufendes Mikrofon" : "Mein laufender Bildschirmton", { exact: true }).check();
  await panel.getByRole("button", { name: "Auswahl ausdrücklich freigeben" }).click();
  await panel.getByText("Serverbestätigung erhalten.", { exact: true }).waitFor();
}
