import { Injectable, OnDestroy } from "@angular/core";
import { PeerMeshService } from "../../webrtc/peer-mesh.service";
import { RoomSessionService } from "../../webrtc/room-session.service";
import { MachineScreenSessionService } from "./machine-screen-session.service";
import { MachineScreenAudioSource, ScreenAudioSink } from "./machine-screen-audio-source";

@Injectable()
export class MachineScreenAudioSessionService implements OnDestroy {
  readonly source: MachineScreenAudioSource;
  constructor(session: RoomSessionService, mesh: PeerMeshService, screen: MachineScreenSessionService) {
    this.source = new MachineScreenAudioSource({ authority: () => {
      const context = session.machineContext(), lease = session.machineLease(), surface = screen.source.status();
      if (!session.joined() || !context || !lease || !surface.open
        || !mesh.machineReceive.supports(mesh.ownPeerId(), "screen-audio.publish")) throw new Error("meet_screen_audio_denied");
      return { sourceId: "screen-audio:" + context.hubSessionId, sessionId: lease.sessionId,
        leaseGeneration: lease.generation, membershipEpoch: mesh.membershipEpoch(), screenGeneration: surface.generation, expiresAt: lease.expiresAt };
    }, create: signal => createScreenAudioSink(mesh, signal) });
  }
  ngOnDestroy(): void { this.source.close(); }
}

/** Bounded synthetic graph; no connection to speakers, human capture or remote media. */
export async function createScreenAudioSink(mesh: Pick<PeerMeshService, "attachPublication" | "detachPublication">,
  signal: AbortSignal): Promise<ScreenAudioSink> {
  signal.throwIfAborted();
  const context = new AudioContext({ sampleRate: 48000 });
  let destination: MediaStreamAudioDestinationNode | undefined;
  const pending = new Map<AudioBufferSourceNode, AudioBuffer>();
  let attached = false, closed = false, next = 0;
  const close = () => {
    if (closed) return; closed = true; signal.removeEventListener("abort", abortClose);
    let failed = false;
    const clean = (action: () => void) => { try { action(); } catch { failed = true; } };
    for (const [node, buffer] of pending) {
      node.onended = null;
      try { node.stop(); } catch { /* May not have started after a graph failure. */ }
      clean(() => node.disconnect()); clean(() => buffer.getChannelData(0).fill(0));
    }
    pending.clear();
    clean(() => { for (const track of destination?.stream.getTracks() || []) clean(() => track.stop()); });
    clean(() => { if (attached) mesh.detachPublication("screen-audio"); });
    clean(() => { void context.close().catch(() => undefined); });
    if (failed) throw new Error("meet_screen_audio_cleanup_failed");
  };
  // Abort dispatch must not create an uncaught exception; all cleanup is still
  // attempted and the owning source has already retired this generation.
  const abortClose = () => { try { close(); } catch { /* Closed, no restart. */ } };
  signal.addEventListener("abort", abortClose, { once: true });
  try {
    destination = context.createMediaStreamDestination();
    if (context.sampleRate !== 48000) throw new Error("meet_screen_audio_unsupported");
    await context.resume(); signal.throwIfAborted();
    if (context.state !== "running") throw new Error("meet_screen_audio_unsupported");
    attached = true; mesh.attachPublication("screen-audio", destination.stream);
    return { close, write: samples => {
      signal.throwIfAborted();
      const now = context.currentTime;
      if (closed || context.state !== "running" || pending.size >= 5 || next - now > .4
        || next > 0 && now - next > .2) throw new Error("meet_screen_audio_queue_or_clock_invalid");
      const start = Math.max(next, now + .04), buffer = context.createBuffer(1, 4800, 48000);
      try {
        buffer.copyToChannel(samples, 0);
        const node = context.createBufferSource(); node.buffer = buffer; pending.set(node, buffer); node.connect(destination!);
        node.onended = () => {
          pending.delete(node);
          try { node.disconnect(); } catch { abortClose(); }
          finally { buffer.getChannelData(0).fill(0); }
        };
        node.start(start); next = start + .1;
      } catch (error) {
        buffer.getChannelData(0).fill(0); close(); throw error;
      }
    } };
  } catch (error) { close(); throw error; }
}
