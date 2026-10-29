import { MachineAvatarArtwork } from "./machine-avatar-artwork";
import { AvatarSequenceClock, SequenceFramePosition } from "./machine-avatar-sequence-clock";
import { AvatarSequenceContent } from "./machine-avatar-sequence-contract";
import { PreparedAvatarSequence } from "./machine-avatar-sequence-preparation";

interface SequenceArtworkPorts {
  check(): void;
  progress(): unknown;
  observe?(position: SequenceFramePosition): void;
}

/** Native authority surrounds sample-clock rendering; counters never grant it. */
export function sequenceArtwork(content: AvatarSequenceContent, speechGeneration: number,
  frames: PreparedAvatarSequence, ports: SequenceArtworkPorts): MachineAvatarArtwork {
  let clock: AvatarSequenceClock;
  try { clock = new AvatarSequenceClock(content, speechGeneration); }
  catch (error) { frames.close(); throw error; }
  let closed = false;
  const close = () => { if (!closed) { closed = true; frames.close(); } };
  return { close, draw: drawing => {
    if (closed) throw new Error("meet_avatar_sequence_artwork_closed");
    try {
      ports.check();
      const position = clock.read(ports.progress());
      frames.draw(position.clipIndex, position.frameIndex, drawing);
      // A drawing adapter may have side effects. Refuse frame submission if
      // authority disappeared during it, even when its pixels were staged.
      ports.check();
      drawing.fillStyle = "#ffffff"; drawing.font = "10px sans-serif"; drawing.textAlign = "center";
      const classification = content.clips[position.clipIndex].content.classification;
      drawing.fillText(classification === "production" ? "IMPORTED" : classification === "test_only" ? "TEST" : "SYNTH",
        128, 183);
      ports.observe?.(position);
      ports.check(); // Observation is not authority and cannot retain a revoked frame.
    } catch (error) { close(); throw error; }
  } };
}
