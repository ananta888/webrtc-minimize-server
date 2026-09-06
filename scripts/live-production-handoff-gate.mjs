import assert from "node:assert/strict";

export async function verifyProductionHandoff({ owner, viewer, targetId, programCreates, statuses, manifest }) {
  const programId = new URL(viewer.url()).searchParams.get("program");
  assert.match(programId || "", /^prg_[A-Za-z0-9_-]{16,64}$/);
  const baseline = await owner.evaluate(() => ({ capture: [...window.__captureCalls],
    connections: window.__broadcastGateConnections.length }));
  const creates = programCreates();
  const oldMediaSource = await viewer.locator("app-broadcast-player video").evaluate(video => video.currentSrc);
  await viewer.locator("#broadcast-viewer-quality-mode").selectOption("low");
  const before = new URL(manifest).pathname.split("/")[3];
  const received = Promise.all([
    owner.waitForResponse(response => new URL(response.url()).pathname === `/api/broadcasts/${programId}/native-handoff-control`, { timeout: 90_000 }),
    owner.waitForResponse(response => new URL(response.url()).pathname === `/api/broadcasts/${programId}/native-handoffs`, { timeout: 90_000 }),
    viewer.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname.startsWith("/broadcast/play/res_") && url.pathname.endsWith(".m3u8")
        && !url.pathname.startsWith(`/broadcast/play/${before}/`);
    }, { timeout: 90_000 }),
  ]);
  void received.catch(() => undefined);
  await owner.locator("#broadcast-handoff-target").selectOption(targetId);
  owner.once("dialog", dialog => dialog.accept());
  await owner.locator("#broadcast-handoff").click();
  const [controlResponse, handoffResponse, nextManifest] = await received;
  assert.equal(controlResponse.status(), 200);
  assert.equal(handoffResponse.status(), 201);
  const control = await controlResponse.json(), handoff = await handoffResponse.json();
  assert.equal(handoff.program.programId, programId);
  assert.equal(handoff.program.programEpoch, control.programEpoch + 1);
  assert.equal(handoff.assignment.packagerId, targetId);
  assert.ok(handoff.assignment.fencingRevision > control.writer.fencingRevision);
  await owner.waitForFunction(() => document.querySelector("#broadcast-program-status")?.textContent?.trim() === "Live",
    undefined, { timeout: 60_000 });
  await viewer.waitForFunction(oldSource => {
    const video = document.querySelector("app-broadcast-player video");
    return video instanceof HTMLVideoElement && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && !video.paused && video.currentTime > 0.5 && video.videoWidth > 0 && video.currentSrc !== oldSource;
  }, oldMediaSource, { timeout: 45_000 });
  const resumedAt = await viewer.locator("app-broadcast-player video").evaluate(video => video.currentTime);
  await viewer.waitForFunction(time => {
    const video = document.querySelector("app-broadcast-player video");
    return video instanceof HTMLVideoElement && !video.paused && video.currentTime > time + 1;
  }, resumedAt, { timeout: 15_000 });
  assert.equal(new URL(viewer.url()).searchParams.get("program"), programId);
  assert.equal(await viewer.locator("#broadcast-viewer-quality-mode").inputValue(), "low");
  assert.equal(await viewer.locator("#broadcast-player-start").count(), 0, "continuation must not need a second playback click");
  assert.equal(programCreates(), creates, "handoff must not create a substitute program");
  const after = await owner.evaluate(() => ({ capture: [...window.__captureCalls],
    connections: window.__broadcastGateConnections.length,
    active: window.__broadcastGateConnections.filter(pc => pc.connectionState !== "closed").length }));
  assert.deepEqual(after.capture, baseline.capture, "handoff must not recapture");
  assert.equal(after.connections, baseline.connections + 1);
  assert.equal(after.active, 1, "old publication connection must be closed");
  const oldStop = statuses.findIndex(item => item.programId === programId && item.programEpoch === control.programEpoch
    && item.packagerId === control.writer.packagerId && item.state === "stopped");
  const newReady = statuses.findIndex(item => item.programId === programId && item.programEpoch === handoff.program.programEpoch
    && item.packagerId === targetId && item.state === "running" && item.reasonCode === "OUTPUT_READY");
  assert.ok(oldStop >= 0 && newReady > oldStop, "real predecessor Stop-ACK must precede successor output readiness");
  assert.equal(await viewer.evaluate(async url => (await fetch(url, { cache: "no-store" })).status, manifest), 404);
  console.log("PASS real native handoff: same program, predecessor Stop-ACK, new decoded output, no recapture or second viewer click");
  return nextManifest.url();
}
