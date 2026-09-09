// Private test-only stdio operations. No Tasks, grants, URLs, keys or media input.
import fs from "node:fs/promises";
import readline from "node:readline";
import { machineBrowserFixture } from "./machine-browser-fixture.js";
import { startSyntheticVisualPublisher, grantSyntheticVisualPublisher } from "./machine-visual-publisher.mjs";

async function run() {
const cleanup = [];
const reply = value => process.stdout.write(JSON.stringify(value) + "\n");
let stage = "configuration";
try {
  const source = process.env.MEET_TEST_VISUAL_SOURCE;
  if (!["camera", "screen"].includes(source)) throw new Error("test_visual_source_invalid");
  const f = await machineBrowserFixture({ after: fn => cleanup.push(fn) }, { listenHost: "127.0.0.2", tlsPortProxy: true,
    lifetimeSeconds: 300, hubPublicKey: await fs.readFile(process.env.MEET_TEST_HUB_PUBLIC_KEY, "utf8"),
    observeStage: value => { stage = value; } });
  f.human.setDefaultTimeout(12000);
  reply({ origin: f.origin, room_id: f.roomId, certificate: f.certificatePath, test_network: f.testNetwork });
  let started = false, granted = false, memberReads = 0;
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (line === "stop") break;
    if (line === "members" && ++memberReads <= 240) {
      stage = "members";
      // The analysis panel unmounts the live-view counter. Observe the actual
      // private room membership without navigating or changing source rights.
      const participants = f.app.registry.members(f.roomId).length;
      if (!Number.isInteger(participants) || participants < 1 || participants > 20) throw new Error("test_member_count_invalid");
      reply({ participants });
    } else if (line === "source" && !started) {
      stage = "source";
      await f.human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
      await startSyntheticVisualPublisher(f.human, source); started = true;
      reply({ source_started: true });
    } else if (line === "grant" && started && !granted) {
      stage = "grant";
      await grantSyntheticVisualPublisher(f.human, source); granted = true;
      reply({ source_granted: true });
    } else if (line === "revoke" && granted) {
      stage = "revoke";
      await f.human.locator("app-machine-permissions-panel").getByRole("button", { name: "Meine Freigaben widerrufen" }).click();
      await f.human.locator("app-machine-permissions-panel").getByText("Keine Empfangsfreigabe erteilt.", { exact: true }).waitFor();
      await f.human.locator("app-machine-permissions-panel").getByText("Serverbestätigung erhalten.", { exact: true }).waitFor();
      granted = false; reply({ source_revoked: true });
    } else throw new Error("test_visual_command_invalid");
  }
} catch (error) {
  reply({ bridge_error: "test_visual_bridge_failed", stage,
    ...(error.startupObservation ? { startup: error.startupObservation } : {}) }); process.exitCode = 1;
} finally {
  for (const close of cleanup.reverse()) { try { await close(); } catch { process.exitCode = 1; } }
}
}
if (process.env.MEET_VISUAL_PACKAGED_GATE === "1") await run();
