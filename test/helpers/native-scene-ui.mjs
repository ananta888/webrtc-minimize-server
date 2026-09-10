import assert from "node:assert/strict";

/** Built Angular keyboard flow. HTTP/native observations are explicitly synthetic in this UI fixture. */
export async function installNativeSceneUiFixture(page, programId, getPublisher) {
  const source = "sls_aaaaaaaaaaaaaaaa";
  let queries = 0, applies = 0, sceneRevision = 1, layout = "waiting-slate", selected = [], rejectNext = false;
  let labelQueries = 0, labelsAvailable = true;
  await page.route(`**/api/broadcasts/${programId}/native-source-labels`, route => {
    labelQueries++;
    const input = route.request().postDataJSON(), publisher = getPublisher();
    assert.equal(route.request().method(), "POST"); assert.ok(publisher);
    assert.deepEqual(input, { requestVersion: 1, deviceFingerprint: publisher.deviceFingerprint,
      expectedProgramRevision: 4, expectedProgramEpoch: 1, expectedPackagerId: "pkr_aaaaaaaaaaaaaaaa",
      expectedAssignmentId: "asn_aaaaaaaaaaaaaaaa", expectedFencingRevision: 4, sourceLeaseIds: [source] });
    return route.fulfill({ json: { version: 1, programId, programRevision: 4, programEpoch: 1,
      packagerId: input.expectedPackagerId, assignmentId: input.expectedAssignmentId, fencingRevision: 4,
      bindings: labelsAvailable ? [{ sourceLeaseId: source, publisherPeerId: publisher.id, sourceKind: "screen" }] : [] } });
  });
  await page.route(`**/api/broadcasts/${programId}/native-source-scene`, route => {
    const input = route.request().postDataJSON();
    assert.equal(route.request().method(), "POST");
    assert.equal(input.requestVersion, input.action === "query" ? 2 : 1); assert.equal(input.expectedProgramRevision, 4); assert.equal(input.expectedProgramEpoch, 1);
    assert.match(input.deviceFingerprint, /^[A-Za-z0-9_-]{43}$/);
    const scope = { sceneControlVersion: 1, programId, programRevision: 4, programEpoch: 1,
      packagerId: "pkr_aaaaaaaaaaaaaaaa", assignmentId: "asn_aaaaaaaaaaaaaaaa", fencingRevision: 4 };
    if (input.action === "query") {
      queries++;
      return route.fulfill({ json: { ...scope, outcome: "observed", observedAt: Date.now(), sceneRevision, layout,
        sourceLeaseIds: selected, activeSourceLeaseId: "", availableSources: [{ sourceLeaseId: source, sourceKind: "screen" }] } });
    }
    applies++; assert.equal(input.action, "apply"); assert.equal(input.trigger, "user-action");
    assert.equal(input.expectedSceneRevision, sceneRevision);
    if (rejectNext) return route.fulfill({ json: { ...scope, outcome: "rejected", observedAt: Date.now(), reasonCode: "SCENE_NOT_APPLIED" } });
    sceneRevision++; layout = input.layout; selected = input.sourceLeaseIds;
    return route.fulfill({ json: { ...scope, outcome: "applied", appliedAt: Date.now(), sceneRevision } });
  });
  return async () => {
    await page.locator("#native-scene-heading").waitFor(); assert.equal(queries, 0); assert.equal(applies, 0);
    await page.locator("#native-scene-refresh").press("Enter");
    await page.locator("#native-scene-status", { hasText: "Szenenzustand bestätigt" }).waitFor();
    await page.getByRole("checkbox", { name: new RegExp(`Bildschirm 1.*${getPublisher().name}`) }).waitFor();
    assert.equal(labelQueries, 1);
    await page.locator("#native-scene-layout").selectOption("grid");
    await page.getByRole("checkbox", { name: /Bildschirm 1/ }).press("Space");
    labelsAvailable = false; // Revoke the fixture binding before requesting its next observation.
    const emptyLabels = page.waitForResponse(response =>
      new URL(response.url()).pathname === `/api/broadcasts/${programId}/native-source-labels`
      && response.request().method() === "POST");
    await page.locator("#native-scene-refresh").press("Enter");
    assert.equal((await emptyLabels).status(), 200);
    await page.locator("#native-scene-status", { hasText: "Szenenzustand bestätigt" }).waitFor();
    assert.equal(await page.locator("#native-scene-layout").inputValue(), "grid");
    assert.equal(await page.getByRole("checkbox", { name: /Bildschirm 1/ }).isChecked(), true);
    await page.getByRole("checkbox", { name: /Bildschirm 1.*Teilnehmer nicht zugeordnet/ }).waitFor();
    assert.equal(labelQueries, 2);
    assert.equal(await page.getByRole("checkbox", { name: new RegExp(`Bildschirm 1.*${getPublisher().name}`) }).count(), 0);
    assert.equal(applies, 0, "refresh preserves the local draft without applying it");
    // Explicitly synthetic concurrent director change; never a native media claim.
    sceneRevision++; layout = "end-slate";
    await page.locator("#native-scene-refresh").press("Enter");
    await page.locator("#native-scene-draft-conflict").waitFor();
    assert.equal(await page.locator("#native-scene-apply").isDisabled(), true);
    assert.equal(await page.locator("#native-scene-layout").inputValue(), "grid");
    // Each confirmation is a separate user decision, not one five-second
    // operation. Observe a fresh query and rendered enabled control explicitly:
    // locator.press does not wait for actionability on a disabled button.
    const refreshForDecision = async selector => {
      const response = page.waitForResponse(response =>
        new URL(response.url()).pathname === `/api/broadcasts/${programId}/native-source-scene`
        && response.request().postDataJSON()?.action === "query");
      await page.locator("#native-scene-refresh:not([disabled])").waitFor();
      await page.locator("#native-scene-refresh").press("Enter");
      assert.equal((await response).status(), 200);
      await page.locator(selector + ":not([disabled])").waitFor();
    };
    await page.locator("#native-scene-draft-review:not([disabled])").waitFor();
    const reviewCancel = page.waitForEvent("dialog"), reviewCancelClick = page.locator("#native-scene-draft-review").press("Enter");
    await (await reviewCancel).dismiss(); await reviewCancelClick;
    assert.equal(await page.locator("#native-scene-apply").isDisabled(), true);
    await refreshForDecision("#native-scene-draft-review");
    const review = page.waitForEvent("dialog"), reviewClick = page.locator("#native-scene-draft-review").press("Enter");
    await (await review).accept(); await reviewClick;
    assert.equal(applies, 0, "review is not publication or apply consent");
    await refreshForDecision("#native-scene-apply");
    const cancelled = page.waitForEvent("dialog"), cancelClick = page.locator("#native-scene-apply").press("Enter");
    await (await cancelled).dismiss(); await cancelClick; assert.equal(applies, 0);
    await refreshForDecision("#native-scene-apply");
    const accepted = page.waitForEvent("dialog"), applyClick = page.locator("#native-scene-apply").press("Enter");
    const dialog = await accepted; assert.match(dialog.message(), /kein Zustellnachweis/); await dialog.accept(); await applyClick;
    await page.locator("#native-scene-status", { hasText: "neu abfragen" }).waitFor();
    assert.equal(applies, 1); assert.equal(queries, 6); assert.deepEqual(selected, [source]);
    await page.locator("#native-scene-refresh").press("Enter");
    await page.locator("#native-scene-status", { hasText: "Szenenzustand bestätigt" }).waitFor();
    assert.equal(await page.locator("#native-scene-layout").inputValue(), "grid");
    await page.getByRole("button", { name: "Quellenplatz entfernen", exact: true }).press("Enter");
    rejectNext = true;
    await page.locator("#native-scene-apply:not([disabled])").waitFor();
    const conflict = page.waitForEvent("dialog"), conflictClick = page.locator("#native-scene-apply").press("Enter");
    await (await conflict).accept(); await conflictClick;
    await page.locator("#native-scene-status", { hasText: "Szene nicht angewendet" }).waitFor();
    assert.equal(applies, 2); assert.equal(queries, 7);
    assert.equal(await page.locator("#native-scene-apply").isDisabled(), true);
  };
}
