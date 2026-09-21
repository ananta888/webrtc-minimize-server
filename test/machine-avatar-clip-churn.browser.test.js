import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { machineBrowserFixture } from "./helpers/machine-browser-fixture.js";
import { waitFixtureValue } from "./helpers/machine-browser-wait.mjs";
import { decodedAvatar } from "./helpers/machine-avatar-coexistence.mjs";
import { installMachineSourceFailureTrace } from "./helpers/machine-source-failure-trace.mjs";

// Real encoded single-colour clips like the Ananta companion swaps per speech
// segment (hold_last) or state (loop). Synthetic pixels and policy only.
function colourClip(colour, { seconds = 1, repeatMode = "hold_last" } = {}) {
  const frames = Math.round(seconds * 12);
  const bytes = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
    `color=c=${colour}:s=256x256:r=12:d=${seconds}`, "-an", "-frames:v", String(frames), "-c:v", "libx264", "-threads", "1",
    "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"],
  { timeout: 15000, maxBuffer: 3_000_000, stdio: ["ignore", "pipe", "pipe"] });
  return { mp4: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), frames,
    repeatMode, originKind: "generated", classification: "test_only" };
}

// Companion-like driver: speech pushes and blocking clip swaps run in ONE
// sequence (the Python worker blocks on page.evaluate during avatar.open).
async function companionReply({ sourceId, speechId, clips, thinking, idle, seconds }) {
  const machine = window.anantaMachine, avatar = machine.avatar;
  const report = { swaps: [], speech: null, errors: [] };
  const swap = async (clip, label) => {
    const previous = avatar.status().generation;
    const t0 = performance.now();
    try {
      if (window.__avatarGen) avatar.close(window.__avatarGen);
      const receipt = await avatar.open(sourceId, "persona-video-v1", clip);
      window.__avatarGen = receipt.generation;
      report.swaps.push({ label, ok: true, previous, generation: receipt.generation, ms: Math.round(performance.now() - t0) });
    } catch (error) {
      window.__avatarGen = 0;
      report.swaps.push({ label, ok: false, previous, error: error?.message, ms: Math.round(performance.now() - t0), status: avatar.status() });
    }
  };
  await swap(thinking, "thinking");
  const total = Math.round(22050 * seconds), segment = Math.round(22050 * (seconds / clips.length));
  const lease = await machine.speech.open(speechId, total);
  const anchor = performance.now();
  let offset = 0, next = 0;
  try {
    while (offset < total) {
      if (next < clips.length && performance.now() >= anchor + (next * segment) / 22050 * 1000 - 180) {
        await swap(clips[next], "segment" + next); next++;
      }
      const status = machine.speech.status();
      if (status.state !== "open") throw new Error("speech_" + status.state);
      while (offset < total && offset - status.playedSamples + 441 <= 4410 - 882) {
        const count = Math.min(441, total - offset);
        const bytes = new Uint8Array(count * 2), view = new DataView(bytes.buffer);
        for (let n = 0; n < count; n++) view.setInt16(n * 2, Math.round(12000 * Math.sin(2 * Math.PI * 440 * (offset + n) / 22050)), true);
        machine.speech.push(lease.generation, offset, btoa(String.fromCharCode(...bytes))); offset += count;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    report.speech = { ok: true, status: machine.speech.status() };
  } catch (error) { report.speech = { ok: false, error: error?.message, status: machine.speech.status() }; }
  await swap(idle, "idle");
  return report;
}

test("chromium survives companion-like clip swaps with concurrent speech pushes", { timeout: 180000 }, async t => {
  const clips = [colourClip("red", { seconds: 3 }), colourClip("blue", { seconds: 3 })];
  const idle = colourClip("lime", { seconds: 2, repeatMode: "loop" }), thinking = colourClip("yellow", { seconds: 2, repeatMode: "loop" });
  const f = await machineBrowserFixture(t, { humanEngine: "chromium" }), { machine, human } = f;
  const console_ = [];
  machine.on("console", message => { const text = message.text(); if (text.includes("[e2eedbg]") || message.type() === "error") console_.push(text.slice(0, 220)); });
  await machine.evaluate(installMachineSourceFailureTrace);
  await machine.evaluate(([room, grant]) => window.anantaMachine.join(room, grant),
    [f.roomId, await f.grant(["avatar.publish", "speech.publish", "chat.send"])]);
  await human.locator("#participant-count", { hasText: "2 / 20" }).waitFor();
  await human.locator(".nav-item").filter({ hasText: /^Live/ }).click();
  const sourceId = "avatar:" + f.binding.sessionId, speechId = "speech:" + f.binding.sessionId;
  await machine.evaluate(() => {
    window.__avatarGen = 0;
    window.__avatarTimer = setInterval(() => {
      try { if (window.__avatarGen) window.anantaMachine.avatar.pulse(window.__avatarGen); } catch { window.__avatarGen = 0; }
    }, 1000);
  });
  const reports = [];
  try {
    const first = await machine.evaluate(async ([id, clip]) => {
      const receipt = await window.anantaMachine.avatar.open(id, "persona-video-v1", clip); window.__avatarGen = receipt.generation; return receipt;
    }, [sourceId, idle]);
    t.diagnostic(JSON.stringify({ first }));
    await waitFixtureValue(human, decodedAvatar, null, { timeout: 8000, accept: v => v?.center?.[1] > 170 && v.center[0] < 70 });
    for (let reply = 0; reply < 3; reply++) {
      const report = await machine.evaluate(companionReply, { sourceId, speechId, clips: [...clips, ...clips], thinking, idle, seconds: 12 });
      reports.push(report);
      t.diagnostic(JSON.stringify({ reply, report }));
      await waitFixtureValue(human, decodedAvatar, null, { timeout: 8000, accept: v => v?.center?.[1] > 170 && v.center[0] < 70 });
    }
  } finally {
    t.diagnostic(JSON.stringify({ trace: await machine.evaluate(() => window.__machineSourceFailureTrace.snapshot()).catch(() => null) }));
    for (const line of console_.slice(-60)) t.diagnostic(line);
    await machine.evaluate(() => { clearInterval(window.__avatarTimer); window.anantaMachine.avatar.close(); window.anantaMachine.leave(); }).catch(() => {});
  }
  for (const report of reports) {
    assert.equal(report.speech?.ok, true, JSON.stringify(report.speech));
    for (const swap of report.swaps) {
      assert.equal(swap.ok, true, JSON.stringify(swap));
      assert.ok(swap.ms < 1500, `swap ${swap.label} took ${swap.ms}ms`);
    }
  }
});
