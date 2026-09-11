import assert from "node:assert/strict";
import test from "node:test";
import { nativeSceneLiveFixture } from "./helpers/native-scene-live-fixture.mjs";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";
import { observeBrowserStartup } from "./helpers/machine-browser-startup.mjs";
import { confirm, outputAudio, publishOwnMicrophone, resources } from "./helpers/native-source-own-microphone.mjs";

test("rendered source handoff drains the real writer, preserves mono AAC and requires fresh source consent", { timeout: 120000 }, async t => {
  if (process.platform !== "linux") { t.skip("Two native processes require Linux containment and local FFmpeg"); return; }
  const f = await nativeSceneLiveFixture(t, { packagerCount: 2, allowSyntheticAudio: true }), { page } = f;
  const browserErrors = observeBrowserStartup(page);
  page.setDefaultTimeout(5000);
  let verified = false;
  t.after(() => { if (!verified) t.diagnostic(JSON.stringify({ synthetic: true, observation: f.observation })); });
  await waitFixtureValue(page, async ids => {
    const r = await fetch("/api/native-packagers", { headers: { authorization: `Bearer ${sessionStorage.getItem("webrtc.oidc.access-token")}` } });
    const rows = (await r.json()).packagers;
    return ids.every(id => rows?.some(p => p.id === id && p.online && p.capability?.capabilityVersion === 6 && p.capability.sourceSceneControlVersion === 2));
  }, f.packagerIds, { timeout: 15000 });
  for (const id of f.packagerIds) assert.equal((await f.request("PUT", `/api/native-packagers/${id}/room-consents/${f.roomId}`, { enabled: true })).status, 200);
  await page.locator("#mesh-analysis-navigation").press("Enter");
  await page.locator("#native-packager-analysis-panel").getByRole("button", { name: "Aktualisieren", exact: true }).click();
  await page.locator("#broadcast-navigation").press("Enter"); await page.locator("#native-source-program-open").press("Enter");
  await page.locator(`#native-source-packager option[value="${f.packagerId}"]`).waitFor({ state: "attached" });
  await page.locator("#native-source-packager").selectOption(f.packagerId);
  await page.locator("#native-source-audio-preset").selectOption("speech");
  assert.equal(await page.evaluate(() => window.__sceneCaptures), 0);
  await confirm(page, () => page.locator("#native-source-start").press("Enter"));
  await page.locator("#native-source-status", { hasText: "Ausgabe vom Packager bestätigt" }).waitFor({ timeout: 15000 });
  await page.locator("#toggle-microphone").click(); await publishOwnMicrophone(page);
  const before = await outputAudio(f.output, true), oldResources = await resources(f.output);
  assert.equal(oldResources.length, 1);
  const old = (await f.request("GET", "/api/native-packagers")).body.assignments.find(a => a.packagerId === f.packagerId && a.state === "running");
  assert.ok(old);
  await page.evaluate(() => {
    window.__standbyInitialDisabled = [];
    // Observe insertion, before a later binding/update pass can conceal the
    // initial native state. Never click, change an attribute or expand policy.
    for (const method of ["appendChild", "insertBefore"]) {
      const original = Node.prototype[method];
      Node.prototype[method] = function(node, ...rest) {
        if (node instanceof HTMLButtonElement && node.id === "broadcast-standby-load"
          && window.__standbyInitialDisabled.length < 16) window.__standbyInitialDisabled.push(node.disabled);
        return original.call(this, node, ...rest);
      };
    }
  });
  await page.locator("#native-source-standbys-open").press("Enter");
  const standby = page.locator("app-native-source-program app-native-packager-standby");
  await standby.locator("#broadcast-standby-load").waitFor();
  assert.deepEqual(await page.evaluate(() => window.__standbyInitialDisabled), [true], "new controls start disabled before Angular input binding");
  const standbyRequests = [];
  const observeStandbyRequest = request => {
    const url = new URL(request.url());
    if (standbyRequests.length < 16 && /\/native-standb(?:y-control|ys)$/.test(url.pathname)) {
      standbyRequests.push({ write: request.method() === "PUT", sameProgram: url.pathname.includes(`/${old.programId}/`) });
    }
  };
  page.on("request", observeStandbyRequest); t.after(() => page.off("request", observeStandbyRequest));
  // Private event observation only: Locator.press does not assert that a
  // native button activation reached the current component after @defer.
  await page.evaluate(() => {
    const state = window.__standbyEntry = { attempt: 0, events: [] };
    const buttons = new WeakMap(); let instances = 0;
    for (const type of ["focusin", "keydown", "keyup", "click"]) document.addEventListener(type, event => {
      const button = event.target;
      if (!(button instanceof HTMLButtonElement) || button.id !== "broadcast-standby-load" || state.events.length >= 16) return;
      if (!buttons.has(button)) buttons.set(button, ++instances);
      state.events.push({ type, attempt: state.attempt, instance: buttons.get(button),
        connected: button.isConnected, disabled: button.disabled, focused: document.activeElement === button, trusted: event.isTrusted });
    }, true);
  });
  const loadStandbys = async () => {
    await page.evaluate(() => { window.__standbyEntry.attempt++; });
    const [loaded] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith(`/api/broadcasts/${old.programId}/native-standby-control`)),
      standby.locator("#broadcast-standby-load:not([disabled])").press("Enter"),
    ]).catch(async error => {
      t.diagnostic(JSON.stringify({ stage: "standby-load", requests: standbyRequests, browserErrors,
        interaction: await page.evaluate(() => window.__standbyEntry).catch(() => null),
        ui: await standby.evaluate(element => ({
          loadDisabled: element.querySelector("#broadcast-standby-load")?.matches(":disabled") ?? null,
          hasControl: !!element.querySelector("#broadcast-standby-status"),
          hasError: !!element.querySelector("#broadcast-standby-error"),
        })).catch(() => null) }));
      throw error;
    });
    assert.equal(loaded.status(), 200);
    // HTTP headers are not an Angular render receipt. Do not edit a selection
    // until the service has installed the body and released its busy state.
    await standby.locator("#broadcast-standby-load:not([disabled])").waitFor();
    return loaded.json();
  };
  const initialStandbys = await loadStandbys();
  assert.deepEqual(initialStandbys.standbyPackagerIds, []);
  assert.equal(initialStandbys.standbyRevision, 0);
  await standby.locator("#broadcast-standby-pinned-output", { hasText: "1 Qualitätsstufe(n) · Hardwarebeschleunigung nicht erlaubt" }).waitFor();
  assert.equal(await standby.locator("#broadcast-standby-renditions").count(), 0);
  assert.equal(await standby.getByRole("checkbox").count(), 1);
  assert.equal(await standby.locator(`[data-standby-id="${f.packagerId}"]`).count(), 0);
  await standby.locator(`[data-standby-id="${f.packagerIds[1]}"]`).press("Space");
  await confirm(page, () => standby.locator("#broadcast-standby-save:not([disabled])").press("Enter"), false);
  assert.deepEqual(await loadStandbys(), initialStandbys, "cancel must leave server metadata unchanged");
  await standby.locator(`[data-standby-id="${f.packagerIds[1]}"]`).check();
  const [saved] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith(`/api/broadcasts/${old.programId}/native-standbys`)),
    confirm(page, () => standby.locator("#broadcast-standby-save:not([disabled])").press("Enter")),
  ]);
  assert.equal(saved.status(), 200);
  assert.equal(saved.request().postDataJSON().allowHardwareAcceleration, false);
  assert.equal(saved.request().postDataJSON().requestedRenditions, 1);
  assert.deepEqual(await saved.json(), { ...initialStandbys, standbyRevision: 1, standbyPackagerIds: [f.packagerIds[1]] });
  assert.equal((await f.request("GET", "/api/native-packagers")).body.assignments.length, 1, "standby cannot create a media assignment");
  assert.equal(await page.evaluate(() => window.__sceneCaptures), 1, "standby cannot capture");
  await page.locator("#native-source-handoff-packager").selectOption(f.packagerIds[1]);
  await confirm(page, () => page.locator("#native-source-handoff").press("Enter"), false);
  assert.equal((await f.request("GET", "/api/native-packagers")).body.assignments.filter(a => a.state === "running").length, 1);
  await confirm(page, () => page.locator("#native-source-handoff").press("Enter"));
  await page.locator("#native-source-status", { hasText: "Übergabe läuft" }).waitFor();
  await page.locator("#native-source-status", { hasText: "Ausgabe vom Packager bestätigt" }).waitFor({ timeout: 20000 });
  await page.locator("#native-source-confirmed-packager", { hasText: "Successor scene fixture" }).waitFor();
  const rows = (await f.request("GET", "/api/native-packagers")).body.assignments;
  assert.equal(rows.find(a => a.assignmentId === old.assignmentId)?.state, "stopped");
  const active = rows.filter(a => !["stopped", "failed"].includes(a.state));
  assert.equal(active.length, 1); assert.equal(active[0].packagerId, f.packagerIds[1]);
  assert.equal(active[0].programEpoch, old.programEpoch + 1); assert.ok(active[0].fencingRevision > old.fencingRevision);
  await page.locator("#native-source-standbys-open").press("Enter");
  const clearedStandbys = await loadStandbys();
  assert.deepEqual(await page.evaluate(() => window.__standbyInitialDisabled), [true, true], "replacement controls start disabled too");
  assert.equal(clearedStandbys.programEpoch, old.programEpoch + 1);
  assert.equal(clearedStandbys.standbyRevision, 0); assert.deepEqual(clearedStandbys.standbyPackagerIds, []);
  const silent = await outputAudio(f.output, false), newResources = await resources(f.output);
  assert.equal(newResources.length, 1); assert.notEqual(newResources[0], oldResources[0]);
  assert.equal(await page.evaluate(() => window.__sceneCaptures), 1, "handoff cannot capture or restart a room source");
  assert.equal(await page.locator("#toggle-microphone").getAttribute("aria-pressed"), "true");
  await page.locator("#native-audio-refresh").click();
  await page.locator("#native-audio-status", { hasText: "Audiowerte bestätigt" }).waitFor();
  await page.locator("app-native-source-audio").getByText("48 kbit/s Zielrate.", { exact: false }).waitFor();
  await publishOwnMicrophone(page);
  const after = await outputAudio(f.output, true);
  // Recreate the deferred editor without changing the writer or granting any
  // source again. Every replacement must wait for its actual enabled binding.
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.locator("#mesh-analysis-navigation").press("Enter");
    // Navigation events alone do not prove an Angular render occurred between
    // them. Require actual destruction before testing a fresh deferred editor.
    await page.locator("app-native-source-program").waitFor({ state: "detached" });
    await standby.waitFor({ state: "detached" });
    await page.locator("#broadcast-navigation").press("Enter");
    await page.locator("#native-source-program-open").press("Enter");
    await page.locator("#native-source-standbys-open").press("Enter");
    assert.deepEqual(await loadStandbys(), clearedStandbys);
  }
  assert.deepEqual(await page.evaluate(() => window.__standbyInitialDisabled), [true, true, true, true]);
  assert.equal(await page.evaluate(() => window.__sceneCaptures), 1);
  await page.locator("#native-source-stop").press("Enter");
  await page.locator("#native-source-status", { hasText: "Sendung gestoppt" }).waitFor({ timeout: 15000 });
  assert.equal(await standby.count(), 0, "stop destroys the standby editor");
  assert.equal((await f.request("GET", "/api/native-packagers")).body.assignments.every(a => a.state === "stopped"), true);
  assert.deepEqual(await resources(f.output), []); assert.equal(f.agent.alive(), true); assert.equal(f.successorAgent.alive(), true);
  assert.equal(await page.evaluate(() => window.__sceneCaptures), 1); await page.locator("#toggle-microphone").click();
  t.diagnostic(JSON.stringify({ synthetic: true, productionEvidence: false, nativeProcesses: 2, oldWriterStopped: true,
    epochAdvanced: true, standbyMetadataOnly: true, standbyClearedOnHandoff: true,
    newConsentRequired: true, before: before.encoding, silent: silent.encoding, after: after.encoding }));
  verified = true;
});
