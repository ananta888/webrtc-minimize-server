import assert from "node:assert/strict";

export async function verifyProductionHandoff({ owner, viewer, targetId, programCreates, statuses, manifest, report = console.log }) {
  const programId = new URL(viewer.url()).searchParams.get("program");
  assert.match(programId || "", /^prg_[A-Za-z0-9_-]{16,64}$/);
  const baseline = await owner.evaluate(() => ({ capture: [...window.__captureCalls],
    connections: window.__broadcastGateConnections.length }));
  const creates = programCreates();
  const oldMediaSource = await viewer.locator("app-broadcast-player video").evaluate(video => video.currentSrc);
  await viewer.locator("#broadcast-viewer-quality-mode").selectOption("low");
  const before = new URL(manifest).pathname.split("/")[3];
  const controlResponsePending = owner.waitForResponse(response => new URL(response.url()).pathname === `/api/broadcasts/${programId}/native-handoff-control`, { timeout: 30_000 });
  const handoffRequestPending = owner.waitForRequest(request => new URL(request.url()).pathname === `/api/broadcasts/${programId}/native-handoffs`, { timeout: 30_000 });
  const handoffResponsePending = owner.waitForResponse(response => new URL(response.url()).pathname === `/api/broadcasts/${programId}/native-handoffs`, { timeout: 90_000 });
  const failedRequestPending = owner.waitForEvent("requestfailed", { predicate: request =>
    new URL(request.url()).pathname === `/api/broadcasts/${programId}/native-handoffs`, timeout: 90_000 }).then(request => {
      const failure = request.failure()?.errorText || "unknown";
      const known = ["net::ERR_NETWORK_CHANGED", "net::ERR_ABORTED", "net::ERR_FAILED", "net::ERR_CONNECTION_CLOSED"];
      throw new Error(`native_handoff_transport_failed:${known.includes(failure) ? failure : "unclassified"}`);
    });
  const manifestPending = viewer.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname.startsWith("/broadcast/play/res_") && url.pathname.endsWith(".m3u8")
        && !url.pathname.startsWith(`/broadcast/play/${before}/`);
    }, { timeout: 90_000 });
  for (const pending of [controlResponsePending, handoffRequestPending, handoffResponsePending, failedRequestPending, manifestPending]) void pending.catch(() => undefined);
  await owner.locator("#broadcast-handoff-target").selectOption(targetId);
  owner.once("dialog", dialog => dialog.accept());
  await owner.locator("#broadcast-handoff").click();
  const controlResponse = await controlResponsePending;
  const control = await controlResponse.json();
  const code = value => typeof value?.error === "string" && /^[a-z0-9_-]{1,96}$/.test(value.error) ? value.error : "unavailable";
  assert.equal(controlResponse.status(), 200, `handoff control rejected: ${code(control)}`);
  report("PASS real native handoff control response");
  let handoffResponse;
  let requestObserved = false;
  try {
    await handoffRequestPending; requestObserved = true;
    handoffResponse = await Promise.race([handoffResponsePending, failedRequestPending]);
  }
  catch (error) {
    const ui = await owner.locator("app-broadcast-preflight > .error[role=alert]").allTextContents();
    const bounded = ui.flatMap(value => value.match(/\b(?:broadcast|native|invalid)_[a-z0-9_-]{1,80}\b/g) || []);
    const transport = error instanceof Error && error.message.startsWith("native_handoff_transport_failed:") ? error.message : "no_transport_error";
    throw new Error(`native_handoff_response_missing:request=${requestObserved}:ui=${ui.length > 0}:${bounded.join(",") || "no_bounded_ui_error"}:${transport}`, { cause: error });
  }
  const handoff = await handoffResponse.json();
  assert.equal(handoffResponse.status(), 201, `handoff rejected: ${code(handoff)}`);
  report("PASS real native handoff accepted response");
  let nextManifest;
  try { nextManifest = await manifestPending; }
  catch (error) {
    const inspect = () => {
      const bounded = selector => [...document.querySelectorAll(selector)].flatMap(element =>
        element.textContent?.match(/\b(?:broadcast|native|invalid)_[a-z0-9_-]{1,80}\b/g) || []).slice(0, 5);
      const state = document.querySelector("app-broadcast-player .state")?.getAttribute("data-state") || "absent";
      const video = document.querySelector("app-broadcast-player video");
      const publisher = document.querySelector("#broadcast-program-status")?.textContent?.trim();
      return { errors: bounded("app-broadcast-preflight > .error, #broadcast-open-error, app-broadcast-player [role=alert]"),
        player: /^[a-z-]{1,30}$/.test(state) ? state : "unknown",
        reconnecting: Boolean(document.querySelector("#broadcast-viewer-reconnecting")),
        publisher: ["Live", "Degradiert", "Übergabe läuft", "Gestoppt"].includes(publisher) ? publisher : "other",
        media: video instanceof HTMLVideoElement ? { readyState: video.readyState, paused: video.paused,
          frames: video.getVideoPlaybackQuality().totalVideoFrames } : null };
    };
    const safeCode = value => typeof value === "string" && /^[A-Z_a-z0-9-]{1,64}$/.test(value) ? value : "unknown";
    const transitions = statuses.filter(item => item.programId === programId).slice(-16).map(item => ({
      epoch: Number.isSafeInteger(item.programEpoch) ? item.programEpoch : 0,
      role: item.packagerId === targetId ? "successor" : "predecessor", state: safeCode(item.state), reason: safeCode(item.reasonCode),
    }));
    throw new Error(`native_handoff_manifest_missing:${JSON.stringify({ transitions,
      owner: await owner.evaluate(inspect), viewer: await viewer.evaluate(inspect) })}`, { cause: error });
  }
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
  const resumed = await viewer.locator("app-broadcast-player video").evaluate(video => ({
    time: video.currentTime, frames: video.getVideoPlaybackQuality().totalVideoFrames,
  }));
  await viewer.waitForFunction(previous => {
    const video = document.querySelector("app-broadcast-player video");
    return video instanceof HTMLVideoElement && !video.paused && video.currentTime > previous.time + 1
      && video.getVideoPlaybackQuality().totalVideoFrames > previous.frames;
  }, resumed, { timeout: 15_000 });
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
  report("PASS real native handoff: same program, predecessor Stop-ACK, new decoded output, no recapture or second viewer click");
  return nextManifest.url();
}
