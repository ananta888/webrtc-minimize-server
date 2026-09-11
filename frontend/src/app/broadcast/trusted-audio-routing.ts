export type TrustedAudioRoute = "microphone" | "screen-audio" | "program" | "talkback" | "room-playback" | "monitor";

const INPUTS = new Set<TrustedAudioRoute>(["microphone", "screen-audio", "talkback"]);
const OUTPUTS = new Set<TrustedAudioRoute>(["program", "talkback", "room-playback", "monitor"]);

/** Closed routing: headphones monitoring must never re-enter capture or program. */
export function trustedAudioRouteAllowed(from: TrustedAudioRoute, to: TrustedAudioRoute): boolean {
  if (!INPUTS.has(from) && from !== "program" && from !== "talkback") return false;
  if (!OUTPUTS.has(to)) return false;
  if (from === "monitor") return false;
  if (to === "microphone" || to === "screen-audio") return false;
  if (from === "talkback" && to === "program") return false;
  return true;
}
