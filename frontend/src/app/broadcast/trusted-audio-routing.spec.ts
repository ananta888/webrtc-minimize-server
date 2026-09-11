import { expect, it } from "vitest";
import { trustedAudioRouteAllowed } from "./trusted-audio-routing";

it("forbids monitor and talkback from re-entering capture or program", () => {
  expect(trustedAudioRouteAllowed("microphone", "program")).toBe(true);
  expect(trustedAudioRouteAllowed("screen-audio", "monitor")).toBe(true);
  expect(trustedAudioRouteAllowed("program", "monitor")).toBe(true);
  expect(trustedAudioRouteAllowed("monitor", "microphone")).toBe(false);
  expect(trustedAudioRouteAllowed("monitor", "program")).toBe(false);
  expect(trustedAudioRouteAllowed("talkback", "program")).toBe(false);
  expect(trustedAudioRouteAllowed("microphone", "microphone")).toBe(false);
});
