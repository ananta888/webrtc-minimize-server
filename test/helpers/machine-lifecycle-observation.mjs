// Serialized into the already-owned test browser; read-only, no policy/capture.
export function beforeMachineLeaseExpiry(deadline) {
  if (Date.now() < deadline - 700) return false;
  const api = window.anantaMachine, status = api.status();
  return { joined: status.joined, open: api.screen.status().open,
    error: window.__leaseSource.error, e2ee: status.e2ee, observedAt: Date.now() };
}

export function retiredMachineAvatar(expectedParticipants) {
  const api = window.anantaMachine, status = api.status();
  const avatar = api.avatar.status();
  return status.joined === true && status.peers === expectedParticipants
    && (avatar.state === "failed" || avatar.state === "closed");
}
