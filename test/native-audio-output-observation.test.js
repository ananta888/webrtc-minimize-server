import assert from "node:assert/strict";
import test from "node:test";
import { nativeAudioFragmentNames } from "./helpers/native-audio-output.mjs";

const manifest = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:3\n#EXT-X-MAP:URI="init_0.mp4"\n#EXTINF:2,\nsegment_000000003.m4s\n';
test("synthetic audio fragment observation accepts only bounded local media names", () => {
  assert.deepEqual(nativeAudioFragmentNames(manifest), { init: "init_0.mp4", segment: "segment_000000003.m4s", sequence: 3, segments: 1 });
  for (const bad of [null, "x".repeat(65537), manifest.replace("init_0.mp4", "../private.pem"),
    manifest.replace("segment_000000003.m4s", "https://example.test/private"), manifest.replace("segment_000000003.m4s", "../secret"),
    manifest.replace("MEDIA-SEQUENCE:3", "MEDIA-SEQUENCE:9007199254740992"), manifest + "segment_000000003.m4s\n".repeat(8)]) {
    assert.throws(() => nativeAudioFragmentNames(bad), /test_audio_manifest_invalid/);
  }
});
