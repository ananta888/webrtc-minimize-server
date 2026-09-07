import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";

test("v2 synthetic speech and avatar are independent outputs beside an owned screen, without implicit chat or capture", { timeout: 100_000 }, async t => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 5000 }); }
  catch { t.skip("ffmpeg is unavailable; synthetic media decoding not verified"); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), "meet-media-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "synthetic.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", "-c:v", "libx264",
    "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", file],
  { timeout: 20_000, stdio: "ignore" });
  const encoded = (await readFile(file)).toString("base64");
  const f = await machineBrowserFixture(t);
  await f.machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant),
    [f.roomId, await f.grant(["avatar.publish", "speech.publish", "screen.publish", "screen-audio.publish"])]);
  await f.human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
  const sourceId = "media:" + f.binding.sessionId;
  assert.equal(await f.machine.evaluate(async id => {
    try { await window.anantaMachine.screenAudio.open(id); return true; } catch { return false; }
  }, "screen-audio:" + f.binding.sessionId), false, "screen audio requires its owned screen activation");
  const stats = () => f.human.evaluate(async () => {
    let frames = 0, samples = 0;
    for (const pc of window.__pcs) for (const stat of (await pc.getStats()).values()) {
      if (stat.type === "inbound-rtp") { frames += stat.framesDecoded || 0; samples += stat.totalSamplesReceived || 0; }
    }
    return { frames, samples };
  });
  // No chat capability exists; separate media publication must not require or emit chat.
  const before = await stats();
  await f.machine.evaluate(input => window.anantaMachine.media.publish(input), {
    schema: "ananta.meet-media-source.v1", sourceId, outputs: ["avatar"], mp4Base64: encoded });
  const avatar = await stats();
  assert.ok(avatar.frames - before.frames > 3, "human decoded avatar frames");
  assert.equal(avatar.samples, before.samples, "unselected speech was not published");
  assert.deepEqual(await f.machine.evaluate(() => window.anantaMachine.status().chat.filter(entry => !entry.system)), []);

  // Continue screen pushes while speech completes; media cleanup must not detach screen.
  const lease = await f.machine.evaluate(id => window.anantaMachine.screen.open(id), "screen:" + f.binding.sessionId);
  const jpeg = await f.human.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "green"; ctx.fillRect(0, 0, 640, 360);
    return canvas.toDataURL("image/jpeg", .7).split(",")[1];
  });
  let stop = false;
  const frames = (async () => {
    for (let seq = 1; !stop && seq <= 100; seq++) {
      await f.machine.evaluate(([gen, seq, jpeg]) => window.anantaMachine.screen.push(gen, seq, jpeg), [lease.generation, seq, jpeg]);
      await new Promise(resolve => setTimeout(resolve, 230));
    }
  })();
  // Attach a handler immediately; no unobserved rejected browser operations during cleanup.
  const pumping = frames.catch(error => error);
  try {
    await f.machine.evaluate(input => window.anantaMachine.media.publish(input), {
      schema: "ananta.meet-media-source.v1", sourceId, outputs: ["speech"], mp4Base64: encoded });
    assert.ok((await stats()).samples - avatar.samples > 1000, "human decoded synthetic speech samples");
    assert.equal(await f.machine.evaluate(() => window.anantaMachine.screen.status().open), true);
    assert.equal(await f.machine.evaluate(() => window.anantaMachine.media.status().active), false);
    const audioBefore = await stats();
    const audio = await f.machine.evaluate(id => window.anantaMachine.screenAudio.open(id), "screen-audio:" + f.binding.sessionId);
    for (let seq = 1; seq <= 30; seq++) {
      await f.machine.evaluate(([generation, sequence]) => {
        const pcm = new Uint8Array(9600), view = new DataView(pcm.buffer);
        for (let i = 0; i < 4800; i++) view.setInt16(i * 2, Math.round(12000 * Math.sin(2 * Math.PI * 440 * (i + (sequence - 1) * 4800) / 48000)), true);
        window.anantaMachine.screenAudio.push(generation, sequence, btoa(String.fromCharCode(...pcm)));
      }, [audio.generation, seq]);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok((await stats()).samples - audioBefore.samples > 15_000, "separate screen audio decoded by human");
    await f.machine.evaluate(() => window.anantaMachine.screenAudio.close());
    assert.equal(await f.machine.evaluate(() => window.anantaMachine.screen.status().open), true, "audio stop preserves video source");
    assert.equal(await f.machine.evaluate(() => window.__captures), 0);
    assert.equal(await f.human.evaluate(() => window.__captures), 0);
  } finally { stop = true; const failure = await pumping; await f.machine.evaluate(() => window.anantaMachine.screen.close()); if (failure) throw failure; }
  await f.machine.evaluate(() => window.anantaMachine.leave());
});
