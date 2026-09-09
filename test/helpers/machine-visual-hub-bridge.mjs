// Private test-only stdio operations. No Tasks, grants, URLs, keys or media input.
import fs from "node:fs/promises";
import readline from "node:readline";
import { machineBrowserFixture } from "./machine-browser-fixture.js";
import { startSyntheticVisualPublisher, grantSyntheticVisualPublisher } from "./machine-visual-publisher.mjs";

const cleanup = [];
const reply = value => process.stdout.write(JSON.stringify(value) + "\n");
try {
  const source = process.env.MEET_TEST_VISUAL_SOURCE;
  if (!["camera", "screen"].includes(source)) throw new Error("test_visual_source_invalid");
  const f = await machineBrowserFixture({ after: fn => cleanup.push(fn) }, { listenHost: "127.0.0.2", tlsPortProxy: true,
    lifetimeSeconds: 300, hubPublicKey: await fs.readFile(process.env.MEET_TEST_HUB_PUBLIC_KEY, "utf8") });
  f.human.setDefaultTimeout(12000);
  reply({ origin: f.origin, room_id: f.roomId, certificate: f.certificatePath, test_network: f.testNetwork });
  let started = false, granted = false;
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (line === "stop") break;
    if (line === "source" && !started) {
      await f.human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
      await startSyntheticVisualPublisher(f.human, source); started = true;
      reply({ source_started: true });
    } else if (line === "grant" && started && !granted) {
      await grantSyntheticVisualPublisher(f.human, source); granted = true;
      reply({ source_granted: true });
    } else if (line === "revoke" && granted) {
      await f.human.locator("app-machine-permissions-panel").getByRole("button", { name: "Meine Freigaben widerrufen" }).click();
      granted = false; reply({ source_revoked: true });
    } else throw new Error("test_visual_command_invalid");
  }
} catch {
  reply({ bridge_error: "test_visual_bridge_failed" }); process.exitCode = 1;
} finally {
  for (const close of cleanup.reverse()) { try { await close(); } catch { process.exitCode = 1; } }
}
