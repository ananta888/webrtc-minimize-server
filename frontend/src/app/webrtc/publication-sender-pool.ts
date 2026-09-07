interface Slot {
  readonly sender: RTCRtpSender; readonly kind: string;
  state: "active" | "idle" | "pending" | "retiring" | "failed";
}

/** addTrack alone grows SDP after repeated stop/start: formerly sending
 * transceivers are not automatically reusable. Reuse only slots we own, after
 * explicit crypto setup, and never while a previous replaceTrack is pending. */
export class PublicationSenderPool {
  private readonly connections = new WeakMap<RTCPeerConnection, Slot[]>();
  constructor(private readonly maxSlots = 80) {
    // 20 members * four publication kinds, including the explicit legacy relay.
    if (!Number.isInteger(maxSlots) || maxSlots < 1 || maxSlots > 80) throw new Error("sender_slot_limit_invalid");
  }
  acquire(pc: RTCPeerConnection, track: MediaStreamTrack, stream: MediaStream,
    configure: (sender: RTCRtpSender) => void, authorized: () => boolean): { sender: RTCRtpSender; ready: Promise<boolean> } {
    if (pc.connectionState === "closed" || track.readyState !== "live" || !authorized()) throw new Error("sender_slot_denied");
    const slots = this.connections.get(pc) || [];
    this.connections.set(pc, slots);
    const transceivers = pc.getTransceivers?.() || [];
    const slot = slots.find(slot => slot.state === "idle" && slot.kind === track.kind && slot.sender.track === null
      && transceivers.some(t => t.sender === slot.sender && t.direction !== "stopped" && t.currentDirection !== "stopped"));
    if (!slot) {
      if (slots.length >= this.maxSlots) throw new Error("sender_slot_limit");
      const sender = pc.addTrack(track, stream), created: Slot = { sender, kind: track.kind, state: "active" };
      slots.push(created);
      try { configure(sender); }
      catch (error) { this.release(pc, sender); throw error; }
      return { sender, ready: Promise.resolve(true) };
    }
    const transceiver = transceivers.find(t => t.sender === slot.sender)!;
    slot.state = "pending";
    try { configure(slot.sender); }
    catch (error) { slot.state = "idle"; throw error; }
    const ready = (async () => {
      try {
        await slot.sender.replaceTrack(track);
        if (slot.state === "retiring" || !authorized() || pc.connectionState === "closed" || track.readyState !== "live") {
          this.remove(pc, slot.sender); slot.state = "idle"; return false;
        }
        slot.sender.setStreams(stream);
        if (transceiver.direction === "inactive") transceiver.direction = "sendonly";
        else if (transceiver.direction === "recvonly") transceiver.direction = "sendrecv";
        slot.state = "active"; return true;
      } catch (error) {
        // Failed slots are never silently retried or granted to a new writer.
        this.remove(pc, slot.sender); slot.state = "failed"; throw error;
      }
    })();
    return { sender: slot.sender, ready };
  }
  release(pc: RTCPeerConnection, sender: RTCRtpSender): void {
    const slot = this.connections.get(pc)?.find(slot => slot.sender === sender);
    this.remove(pc, sender);
    if (!slot || slot.state === "failed") return;
    // A late replacement may reattach a track after removeTrack. Keep the slot
    // reserved until its completion removes it again; no new writer can race it.
    slot.state = slot.state === "pending" || slot.state === "retiring" ? "retiring" : "idle";
  }
  private remove(pc: RTCPeerConnection, sender: RTCRtpSender): void {
    try { pc.removeTrack(sender); } catch { /* Closed peer has no live sender. */ }
  }
}
