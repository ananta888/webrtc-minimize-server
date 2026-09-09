// Explicit private-fixture fault injection, never a production control port.
export class MultiHubReconnect {
  constructor(registry, roomId) {
    this.registry = registry; this.roomId = roomId;
    this.pending = null; this.retired = []; this.interruptions = 0;
  }
  interrupt(peers) {
    const members = this.registry.members(this.roomId);
    const owned = members.filter(member => member.id === peers?.[0] && member.machine === true);
    if (this.pending || this.interruptions >= 3 || peers?.length !== 2 || peers[0] === peers[1]
      || members.length !== 3 || owned.length !== 1 || !members.some(member => member.id === peers[1])
      || typeof owned[0].socket?.terminate !== "function") throw new Error("test_reconnect_owner_invalid");
    this.pending = { id: owned[0].id, principal: owned[0].principal, device: owned[0].deviceFingerprint, survivor: peers[1] };
    this.retired.push(owned[0].id); ++this.interruptions;
    owned[0].socket.terminate();
    return { interrupted: 0, attempt: this.interruptions };
  }
  replace(peers) {
    const previous = this.pending, members = this.registry.members(this.roomId);
    if (!previous || this.interruptions > 2 || peers?.[0] !== previous.id || peers[1] !== previous.survivor
      || members.length !== 3 || members.some(member => this.retired.includes(member.id))
      || !members.some(member => member.id === previous.survivor)) throw new Error("test_reconnect_replacement_invalid");
    const owned = members.filter(member => member.machine === true && member.principal === previous.principal);
    if (owned.length !== 1 || owned[0].deviceFingerprint !== previous.device) throw new Error("test_reconnect_replacement_invalid");
    this.pending = null;
    return [owned[0].id, previous.survivor];
  }
}
