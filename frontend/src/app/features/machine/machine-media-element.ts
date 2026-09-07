import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { MachineMediaHandle, MachineMediaOutput } from "./machine-media-publication";
import { MachinePublicationOwnership } from "./machine-publication-ownership";

/** MP4 adapter shares source ownership with independent PCM and avatar writers. */
export function createMachineMediaElement(bytes: Uint8Array<ArrayBuffer>, outputs: readonly MachineMediaOutput[],
  mesh: Pick<PeerMeshService, "attachPublication" | "detachPublication">,
  ownership: Pick<MachinePublicationOwnership, "claim">): MachineMediaHandle {
  const claim = ownership.claim(outputs.map(output => output === "avatar" ? "camera" : "microphone"));
  let video: (HTMLVideoElement & { captureStream(): MediaStream }) | undefined;
  let stream: MediaStream | undefined, url = "", closed = false;
  const attached: ("camera" | "microphone")[] = [];
  const release = (action: () => void) => { try { action(); } catch { /* Continue independent cleanup. */ } };
  const close = () => {
    if (closed) return; closed = true;
    release(() => video?.pause());
    stream?.getTracks().forEach(track => release(() => track.stop()));
    for (const source of attached) if (claim.owns(source)) release(() => mesh.detachPublication(source));
    release(() => { video?.removeAttribute("src"); video?.load(); });
    if (url) release(() => URL.revokeObjectURL(url));
    claim.release();
  };
  try {
    video = document.createElement("video") as typeof video & {};
    if (typeof video.captureStream !== "function") throw new Error("machine_media_unsupported");
    url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
    video.src = url; video.preload = "auto";
    return { ready: () => !closed && video!.readyState >= 2,
      metadata: () => ({ duration: video!.duration, width: video!.videoWidth, height: video!.videoHeight }),
      attach: selected => {
        if (closed || stream || selected.length !== outputs.length || selected.some(output => !outputs.includes(output))) {
          throw new Error("machine_media_attachment_denied");
        }
        stream = video!.captureStream();
        for (const [output, source, tracks] of [
          ["avatar", "camera", stream.getVideoTracks()], ["speech", "microphone", stream.getAudioTracks()],
        ] as const) {
          if (!selected.includes(output)) { tracks.forEach(track => track.stop()); continue; }
          if (tracks.length !== 1 || !claim.owns(source)) throw new Error("machine_media_tracks_missing");
          attached.push(source); mesh.attachPublication(source, new MediaStream(tracks));
        }
      }, play: () => video!.play(), ended: () => video!.ended, failed: () => Boolean(video!.error), close };
  } catch (error) { close(); throw error; }
}
