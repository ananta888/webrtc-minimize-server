import assert from "node:assert/strict";
import test from "node:test";
import { nativeAudioFragmentNames, nativeAudioOutputObservation, nativeOutputMasterRenditions } from "./helpers/native-audio-output.mjs";
import { nativeSceneOutputProfile } from "./helpers/native-scene-output-profile.mjs";

test("master observation accepts only bounded native variant entries, never arbitrary paths", () => {
  const text = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=648600,RESOLUTION=640x360\nlow/index.m3u8\n";
  assert.deepEqual(nativeOutputMasterRenditions(text), [{ id: "low", width: 640, height: 360 }]);
  for (const invalid of ["", "x".repeat(65537), text.replace("low/index", "../secret"), text.replace("640x360", "99999999999999999x360"),
    text + text.split("\n").slice(3).join("\n"), text.replace("low/index.m3u8", "https://external.test/index.m3u8"),
    text.replace("BANDWIDTH=648600", "BANDWIDTH=NaN"), text.replace("low/index.m3u8\n", "")]) {
    assert.throws(() => nativeOutputMasterRenditions(invalid), /test_output_master_invalid/);
  }
});

test("ladder fixture uses a bounded explicit output budget without overriding CPU class", () => {
  assert.deepEqual(nativeSceneOutputProfile(), { NATIVE_PACKAGER_MAX_RENDITIONS: "1" });
  assert.deepEqual(nativeSceneOutputProfile("ladder-v1"), { NATIVE_PACKAGER_MAX_RENDITIONS: "3",
    NATIVE_PACKAGER_MAX_PIXELS_PER_SECOND: "43545600", NATIVE_PACKAGER_UPLOAD_CLASS: "over-15mbit" });
  assert.ok(Object.isFrozen(nativeSceneOutputProfile("ladder-v1")));
  for (const value of [null, {}, 3, "unbounded", "ladder-v2"]) assert.throws(() => nativeSceneOutputProfile(value));
});

test("multi-rendition observation accepts only fixed layer names before filesystem access", async () => {
  for (const renditionId of [null, 1, "", "../low", "LOW", "low/../../secret", "high\n"]) {
    await assert.rejects(nativeAudioOutputObservation("/not-opened", { renditionId }), /test_output_rendition_invalid/);
  }
});

const manifest = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:3\n#EXT-X-MAP:URI="init_0.mp4"\n#EXTINF:2,\nsegment_000000003.m4s\n';
test("synthetic audio fragment observation accepts only bounded local media names", () => {
  assert.deepEqual(nativeAudioFragmentNames(manifest), { init: "init_0.mp4", segment: "segment_000000003.m4s", sequence: 3, segments: 1 });
  for (const bad of [null, "x".repeat(65537), manifest.replace("init_0.mp4", "../private.pem"),
    manifest.replace("segment_000000003.m4s", "https://example.test/private"), manifest.replace("segment_000000003.m4s", "../secret"),
    manifest.replace("MEDIA-SEQUENCE:3", "MEDIA-SEQUENCE:9007199254740992"), manifest + "segment_000000003.m4s\n".repeat(8)]) {
    assert.throws(() => nativeAudioFragmentNames(bad), /test_audio_manifest_invalid/);
  }
});
