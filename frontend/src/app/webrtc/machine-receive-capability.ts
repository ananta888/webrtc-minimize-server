/** Source-kind ceiling; a capability alone never grants a publication or key. */
export function machineReceiveCapability(source: string): "audio.receive" | "video.receive" | null {
  if (["microphone", "screen-audio"].includes(source)) return "audio.receive";
  if (["camera", "screen"].includes(source)) return "video.receive";
  return null;
}
