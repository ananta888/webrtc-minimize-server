// Private synthetic spoken-source fixture; stdin cannot supply media or policy.
import fs from "node:fs/promises";
import readline from "node:readline";
import { machineBrowserFixture } from "./machine-browser-fixture.js";
import { startSyntheticAudioPublisher, grantSyntheticAudioPublisher } from "./machine-audio-publisher.mjs";

async function run() {
const cleanup = [];
const reply = value => process.stdout.write(JSON.stringify(value) + "\n");
let stage = "configuration";
try {
  const source = process.env.MEET_TEST_AUDIO_SOURCE;
  if (!["microphone", "screen-audio"].includes(source)) throw new Error("test_audio_source_invalid");
  const f = await machineBrowserFixture({ after: fn => cleanup.push(fn) }, { listenHost: "127.0.0.2", tlsPortProxy: true,
    lifetimeSeconds: 300, hubPublicKey: await fs.readFile(process.env.MEET_TEST_HUB_PUBLIC_KEY, "utf8"),
    observeStage: value => { stage = value; } });
  f.human.setDefaultTimeout(12000);
  reply({ origin: f.origin, room_id: f.roomId, certificate: f.certificatePath, test_network: f.testNetwork });
  let started = false, granted = false, spoken = false;
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (line === "stop") break;
    if (line === "source" && !started) {
      stage = "source";
      await f.human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
      await startSyntheticAudioPublisher(f.human, source, process.env.MEET_TEST_AUDIO_WAV); started = true;
      reply({ source_started: true });
    } else if (line === "grant" && started && !granted) {
      stage = "grant";
      await grantSyntheticAudioPublisher(f.human, source); granted = true;
      reply({ source_granted: true });
    } else if (line === "speak" && granted && !spoken) {
      stage = "speak";
      await f.human.evaluate(() => window.__startSyntheticReceiveSpeech()); spoken = true;
      reply({ speech_started: true });
    } else if (line === "revoke" && granted) {
      stage = "revoke";
      const panel = f.human.locator("app-machine-permissions-panel");
      await panel.getByRole("button", { name: "Meine Freigaben widerrufen" }).click();
      await panel.getByText("Keine Empfangsfreigabe erteilt.", { exact: true }).waitFor();
      await panel.getByText("Serverbestätigung erhalten.", { exact: true }).waitFor();
      granted = false; reply({ source_revoked: true });
    } else throw new Error("test_audio_command_invalid");
  }
} catch {
  reply({ bridge_error: "test_audio_bridge_failed", stage }); process.exitCode = 1;
} finally {
  for (const close of cleanup.reverse()) { try { await close(); } catch { process.exitCode = 1; } }
}
}
if (process.env.MEET_AUDIO_PACKAGED_GATE === "1") await run();
