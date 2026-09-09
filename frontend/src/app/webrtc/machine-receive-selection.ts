export interface VisualReceiveSelection { readonly camera: boolean; readonly screen: boolean }

/** Pure selection compilation; never starts capture or grants an absent source. */
export function selectedReceiveSources(microphone: boolean, screenAudio: boolean, visual?: VisualReceiveSelection): string[] {
  if (typeof microphone !== "boolean" || typeof screenAudio !== "boolean"
    || visual !== undefined && (!visual || typeof visual !== "object" || Array.isArray(visual)
      || Object.keys(visual).length !== 2 || !Object.hasOwn(visual, "camera") || !Object.hasOwn(visual, "screen")
      || typeof visual.camera !== "boolean" || typeof visual.screen !== "boolean")) throw new Error("machine_receive_selection_invalid");
  return [microphone ? "microphone" : "", screenAudio ? "screen-audio" : "",
    visual?.camera ? "camera" : "", visual?.screen ? "screen" : ""].filter(Boolean);
}
