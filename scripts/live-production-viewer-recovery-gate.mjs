import assert from "node:assert/strict";

// Only the isolated, explicitly started synthetic viewer receives the one-shot fault.
// Every successful authorization and playback cookie still comes from the real server.
export async function verifyProductionViewerRecovery(viewer, manifest) {
  const url = new URL(viewer.url()), programId = url.searchParams.get("program");
  assert.match(programId || "", /^prg_[A-Za-z0-9_-]{16,64}$/);
  const target = `${url.origin}/api/broadcasts/${programId}/playback`;
  const oldSource = await viewer.locator("app-broadcast-player video").evaluate(video => video.currentSrc);
  await viewer.locator("#broadcast-viewer-quality-mode").selectOption("low");
  let injected = 0;
  const handler = route => {
    if (!injected && route.request().method() === "POST") {
      injected++;
      return route.fulfill({ status: 404, json: { error: "broadcast_not_available" }, headers: { "cache-control": "no-store" } });
    }
    return route.continue();
  };
  await viewer.route(target, handler);
  try {
    const response = await viewer.waitForResponse(candidate => candidate.request().method() === "POST"
      && new URL(candidate.url()).pathname === "/api/broadcast/playback-sessions", { timeout: 140_000 });
    assert.equal(injected, 1, "the explicit one-shot renewal fault must have occurred");
    assert.equal(response.status(), 201);
    const session = await response.json();
    assert.equal(new URL(session.manifestUrl, url.origin).href, manifest, "recovery must retain the authorized output resource");
    await viewer.waitForFunction(previous => {
      const video = document.querySelector("app-broadcast-player video");
      return video instanceof HTMLVideoElement && video.currentSrc !== previous && !video.paused
        && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.getVideoPlaybackQuality().totalVideoFrames > 0;
    }, oldSource, { timeout: 40_000 });
    const frames = await viewer.locator("app-broadcast-player video").evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames);
    await viewer.waitForFunction(previous => {
      const video = document.querySelector("app-broadcast-player video");
      return video instanceof HTMLVideoElement && video.getVideoPlaybackQuality().totalVideoFrames > previous + 2;
    }, frames, { timeout: 15_000 });
    assert.equal(new URL(viewer.url()).searchParams.get("program"), programId);
    assert.equal(await viewer.locator("#broadcast-viewer-quality-mode").inputValue(), "low");
    assert.equal(await viewer.locator("#broadcast-player-start").count(), 0);
    console.log("PASS real viewer recovery: one injected denial, fresh server cookie, same output, advancing decoded frames and no second Play click");
  } finally { await viewer.unroute(target, handler); }
}
