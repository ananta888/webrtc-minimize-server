/** Test process configuration only. CPU classification is never overridden. */
export function nativeSceneOutputProfile(value = "single-v1") {
  if (value === "single-v1") return Object.freeze({ NATIVE_PACKAGER_MAX_RENDITIONS: "1" });
  if (value === "ladder-v1") return Object.freeze({ NATIVE_PACKAGER_MAX_RENDITIONS: "3",
    NATIVE_PACKAGER_MAX_PIXELS_PER_SECOND: "43545600", NATIVE_PACKAGER_UPLOAD_CLASS: "over-15mbit" });
  throw new Error("test_native_scene_output_profile_invalid");
}
