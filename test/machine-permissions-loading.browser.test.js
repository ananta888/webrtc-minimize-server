import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";

// Locate the actual generated component chunk, not a guessed hash or a stub UI.
async function componentChunk(marker) {
  const root = process.env.MEET_TEST_PUBLIC_DIR || fileURLToPath(new URL("../dist/browser/", import.meta.url));
  const matches = [];
  for (const name of await fs.readdir(root)) {
    if (!/^chunk-[A-Z0-9]+\.js$/.test(name)) continue;
    if ((await fs.readFile(path.join(root, name), "utf8")).includes(marker)) matches.push(name);
  }
  assert.equal(matches.length, 1, "production component must remain independently deferred");
  return matches[0];
}

for (const humanEngine of ["chromium", "firefox"]) {
  test(`${humanEngine} failed deferred Ananta permissions remain visible without automatic actions`, { timeout: 45_000 }, async t => {
    const chunk = await componentChunk("machine-receive-heading");
    const f = await machineBrowserFixture(t, { humanEngine, externalMachine: true }), { human } = f;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    let requests = 0;
    const route = async intercepted => { requests++; await held; await intercepted.abort("failed"); };
    await human.route(`**/${chunk}`, route);
    await human.evaluate(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.__recoveryTracks = [];
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await capture(constraints); window.__recoveryTracks.push(...stream.getTracks()); return stream;
      };
    });
    await human.locator("#toggle-microphone").click();
    await human.locator('#toggle-microphone[aria-pressed="true"]').waitFor();
    assert.equal(await human.evaluate(() => window.__recoveryTracks.some(track => track.readyState === "live")), true);
    const before = await human.evaluate(() => ({ captures: window.__captures, peers: window.__pcs.length }));
    assert.equal(before.captures, 1, "only the explicit synthetic microphone click starts capture");
    await human.locator("#mesh-analysis-navigation").press("Enter");
    await human.locator("#machine-permissions-loading").waitFor();
    assert.equal(await human.locator("#machine-permissions-load-error").count(), 0);
    assert.equal(f.app.registry.participantCount, 1);
    release();
    const error = human.locator("#machine-permissions-load-error");
    await error.waitFor();
    assert.match(await error.innerText(), /Bestehende Freigaben sind dadurch nicht widerrufen/);
    assert.equal(await human.locator("app-machine-permissions-panel").count(), 0);
    assert.deepEqual(await human.evaluate(() => ({ captures: window.__captures, peers: window.__pcs.length })), before);
    assert.equal(requests, 1); assert.equal(f.app.registry.participantCount, 1);
    const leave = error.getByRole("button", { name: "Raum verlassen und Freigaben beenden", exact: true });
    await leave.focus(); assert.equal(await leave.evaluate(node => node === document.activeElement), true);
    await human.keyboard.press("Enter");
    await waitFixtureValue(human, () => document.querySelector("#join-room")?.disabled === false);
    assert.equal(f.app.registry.participantCount, 0);
    assert.equal(await error.count(), 0); assert.equal(await human.evaluate(() => window.__captures), 1);
    assert.equal(await human.evaluate(() => window.__recoveryTracks.every(track => track.readyState === "ended")), true);

    // Reopen a fresh document with the same forced failure to exercise the
    // distinct explicit reload button as well as the Leave action above.
    await human.reload();
    await human.locator("#create-room:not([disabled])").waitFor();
    assert.equal(f.app.registry.participantCount, 0);
    assert.equal(await human.evaluate(() => window.__captures), 0);
    await human.locator("#create-room").click();
    await waitFixtureValue(human, () => document.querySelector("#room-id")?.value.startsWith("room-"));
    await human.locator("#join-room").click();
    await human.locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor();
    await human.locator("#mesh-analysis-navigation").press("Enter");
    await error.waitFor();
    assert.equal(requests, 2);
    await human.unroute(`**/${chunk}`, route);
    await error.getByRole("button", { name: "Seite neu laden · Sitzung beenden", exact: true }).press("Enter");
    await human.locator("#create-room:not([disabled])").waitFor();
    assert.equal(f.app.registry.participantCount, 0);
    assert.equal(await human.evaluate(() => window.__captures), 0);
    await human.locator("#create-room").click();
    await waitFixtureValue(human, () => document.querySelector("#room-id")?.value.startsWith("room-"));
    await human.locator("#join-room").click();
    await human.locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor();
    await human.locator("#mesh-analysis-navigation").press("Enter");
    await human.locator("app-machine-permissions-panel").waitFor();
    assert.equal(await error.count(), 0); assert.equal(requests, 2);
    assert.equal(await human.evaluate(() => window.__captures), 0);
  });

  test(`${humanEngine} failed deferred operator status leaves source permissions usable`, { timeout: 35_000 }, async t => {
    const chunk = await componentChunk("machine-admission-heading"), f = await machineBrowserFixture(t, { humanEngine });
    await f.machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant), [f.roomId, await f.grant(["chat.read"])]);
    await f.human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
    await f.human.route(`**/${chunk}`, route => route.abort("failed"));
    await f.human.locator("#mesh-analysis-navigation").press("Enter");
    const panel = f.human.locator("app-machine-permissions-panel");
    await panel.locator("#machine-admission-load-error").waitFor();
    await panel.getByRole("button", { name: "Für diese KI einstellen", exact: true }).click();
    await panel.getByLabel("Meine neuen Chatbeiträge", { exact: true }).check();
    await panel.getByRole("button", { name: "Auswahl ausdrücklich freigeben", exact: true }).click();
    await panel.getByText("Serverbestätigung erhalten.", { exact: true }).waitFor();
    assert.equal(await f.human.evaluate(() => window.__captures), 0);
    assert.equal(f.app.registry.participantCount, 2);
    await panel.getByRole("button", { name: "Meine Freigaben widerrufen", exact: true }).click();
    await panel.getByText("Keine Empfangsfreigabe erteilt.", { exact: true }).waitFor();
  });
}
