import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startSyntheticAudioPublisher } from "./helpers/machine-audio-publisher.mjs";

test("synthetic audio source refuses unknown kinds before file or browser access", async () => {
  for (const source of ["camera", "room-mix", "https://provider.test", null]) {
    await assert.rejects(startSyntheticAudioPublisher({}, source, "/not-read"), /test_audio_source_invalid/);
  }
});

for (const kind of ["empty", "oversized", "wrong-header", "symlink", "directory"]) {
  test(`synthetic audio ${kind} input cannot enter the publisher browser`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meet-test-audio-input-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "fixture.wav");
    if (kind === "directory") await fs.mkdir(file);
    else if (kind === "symlink") {
      const target = path.join(directory, "target.wav"); await fs.writeFile(target, Buffer.alloc(44));
      await fs.symlink(target, file);
    } else await fs.writeFile(file, Buffer.alloc(kind === "empty" ? 0 : kind === "oversized" ? 400001 : 44));
    let accessed = false;
    await assert.rejects(startSyntheticAudioPublisher({ evaluate() { accessed = true; } }, "microphone", file), /test_audio_fixture_invalid/);
    assert.equal(accessed, false);
  });
}
