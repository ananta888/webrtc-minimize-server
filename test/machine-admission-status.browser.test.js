import assert from "node:assert/strict";
import test from "node:test";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";

for (const humanEngine of ["chromium", "firefox"]) {
  test(`${humanEngine} admission panel observes operator state without joining a machine or granting sources`, { timeout: 45_000 }, async t => {
    const { human } = await machineBrowserFixture(t, { humanEngine });
    const baseline = await human.evaluate(() => ({ captures: window.__captures, connections: window.__pcs.length }));
    let requests = 0, mutations = 0;
    human.on("request", request => {
      if (request.url().endsWith("/api/machine/capabilities")) {
        requests++; if (request.method() !== "GET" || request.headers()["authorization"]) mutations++;
      }
    });
    await human.locator(".nav-item", { hasText: "Analyse" }).click();
    const panel = human.locator("app-machine-admission-status");
    await panel.getByText("Maschinenaufnahme ist serverseitig eingeschaltet.", { exact: true }).waitFor();
    assert.equal(requests, 1);
    await human.locator("app-machine-permissions-panel").getByText("Zurzeit ist keine KI im Raum verbunden.", { exact: true }).waitFor();

    // Subsequent responses are controlled UI fixtures, not changes to server trust.
    let fail = false;
    await human.route("**/api/machine/capabilities", route => route.fulfill({
      status: fail ? 503 : 200, contentType: "application/json", body: JSON.stringify({
        schema: "ananta.meet-capabilities.v1", admissionEnabled: false,
        publication: "mp4-v1", sessionLease: "ananta.meet-session-lease.v1",
        chatEvents: false, audioSubscription: false, screenPublication: false,
      }),
    }));
    const refresh = panel.getByRole("button", { name: "Betreiberstatus aktualisieren", exact: true });
    await refresh.focus(); await human.keyboard.press("Enter");
    await panel.getByText("Maschinenaufnahme ist serverseitig ausgeschaltet.", { exact: true }).waitFor();
    await panel.getByText(/Der Betreiber muss zuerst öffentlichen Hub-Trust/).waitFor();
    fail = true; await refresh.click();
    await panel.getByText("Betreiberstatus nicht verlässlich abrufbar.", { exact: true }).waitFor();
    assert.equal(await panel.getByText("Maschinenaufnahme ist serverseitig eingeschaltet.", { exact: true }).count(), 0);
    assert.equal(await panel.getByText(/Zuletzt geprüft:/).count(), 0);
    assert.equal(mutations, 0); assert.equal(requests, 3);
    assert.deepEqual(await human.evaluate(() => ({ captures: window.__captures, connections: window.__pcs.length })), baseline);
    await human.locator(".nav-item").filter({ hasText: /^Live/ }).click();
    assert.equal(await human.locator("#participant-count").innerText(), "1 / 20 Teilnehmer");
  });
}
