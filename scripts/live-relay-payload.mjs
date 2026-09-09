/** Self-contained browser probe. No application payloads or device access. */
export async function liveRelayPayload(iceServers, { timeoutMs = 25000,
  makePeer = config => new RTCPeerConnection(config),
  makeNonce = () => crypto.getRandomValues(new Uint8Array(32)) } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25000
    || !Array.isArray(iceServers) || !iceServers.length || iceServers.length > 16) {
    throw new Error("live_relay_payload_invalid");
  }
  const peers = [], channels = [], removeListeners = [];
  let closed = false, timer, rejectFailure, candidateCount = 0, relayCount = 0;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  const fail = () => { if (!closed) rejectFailure(new Error("live_relay_payload_failed")); };
  const active = () => { if (closed) throw new Error("live_relay_payload_failed"); };
  const listen = (target, name, callback) => {
    target.addEventListener(name, callback);
    removeListeners.push(() => target.removeEventListener(name, callback));
  };
  const gathered = peer => peer.iceGatheringState === "complete" ? Promise.resolve()
    : new Promise(resolve => listen(peer, "icegatheringstatechange", () => {
      if (peer.iceGatheringState === "complete") resolve();
    }));
  const selectedRelay = async peer => {
    if (peer.connectionState !== "connected" || !["connected", "completed"].includes(peer.iceConnectionState)
      || peer.sctp?.state !== "connected" || peer.sctp?.transport?.state !== "connected"
      || peer.getConfiguration().iceTransportPolicy !== "relay") return false;
    const stats = await peer.getStats(); active();
    if (stats.size > 4096) return false;
    const transports = [...stats.values()].filter(row => row.type === "transport" && row.selectedCandidatePairId);
    if (!transports.length || transports.some(row => row.dtlsState !== "connected")) return false;
    const ids = new Set(transports.map(row => row.selectedCandidatePairId));
    if (ids.size !== 1) return false;
    const pair = stats.get([...ids][0]);
    // Some Chromium TCP allocations keep checking an already selected pair.
    // Selection, connected DTLS/SCTP, positive counters and exact echo are all
    // still mandatory; nomination or in-progress alone is never evidence.
    return pair?.type === "candidate-pair" && ["succeeded", "in-progress"].includes(pair.state)
      && Number.isFinite(pair.bytesSent) && pair.bytesSent > 0
      && Number.isFinite(pair.bytesReceived) && pair.bytesReceived > 0
      && stats.get(pair.localCandidateId)?.candidateType === "relay"
      && stats.get(pair.remoteCandidateId)?.candidateType === "relay";
  };
  try {
    timer = setTimeout(fail, timeoutMs);
    const operation = async () => {
      const nonce = makeNonce();
      if (!(nonce instanceof Uint8Array) || nonce.length !== 32) throw new Error();
      const matches = value => value instanceof ArrayBuffer && value.byteLength === nonce.length
        && new Uint8Array(value).every((byte, index) => byte === nonce[index]);
      for (let index = 0; index < 2; index++) {
        const peer = makePeer({ iceServers, iceTransportPolicy: "relay" }); peers.push(peer);
        listen(peer, "connectionstatechange", () => { if (peer.connectionState === "failed") fail(); });
        listen(peer, "icecandidate", event => {
          if (closed || !event.candidate) return;
          if (++candidateCount > 4096) { fail(); return; }
          if ((event.candidate.type || / typ ([a-z]+)(?: |$)/.exec(event.candidate.candidate)?.[1]) === "relay") relayCount++;
        });
      }
      const [left, right] = peers;
      let echoed = false, received = false, acceptEcho;
      const exchange = new Promise(resolve => { acceptEcho = resolve; });
      listen(right, "datachannel", event => {
        if (closed || channels.length !== 1 || event.channel.label !== "turn-gate") { event.channel.close(); fail(); return; }
        const channel = event.channel; channels.push(channel); channel.binaryType = "arraybuffer";
        listen(channel, "message", ({ data }) => {
          if (closed) return;
          if (received || !matches(data)) { fail(); return; }
          received = true;
          try { channel.send(data); } catch { fail(); }
        });
        listen(channel, "error", fail);
      });
      const channel = left.createDataChannel("turn-gate", { ordered: true });
      channels.push(channel); channel.binaryType = "arraybuffer";
      listen(channel, "error", fail);
      listen(channel, "open", () => { if (!closed) { try { channel.send(nonce); } catch { fail(); } } });
      listen(channel, "message", ({ data }) => {
        if (closed) return;
        if (echoed || !received || !matches(data)) { fail(); return; }
        echoed = true; acceptEcho();
      });
      const offer = await left.createOffer(); active();
      await left.setLocalDescription(offer); active();
      await gathered(left); active();
      await right.setRemoteDescription(left.localDescription); active();
      const answer = await right.createAnswer(); active();
      await right.setLocalDescription(answer); active();
      await gathered(right); active();
      await left.setRemoteDescription(right.localDescription); active();
      await exchange; active();
      while (!(await selectedRelay(left) && await selectedRelay(right))) {
        await new Promise(resolve => setTimeout(resolve, 50)); active();
      }
      if (!echoed || !received || relayCount < 2) throw new Error();
      return { candidateCount, relayCount, selectedRelayPairs: 2, payloadBytesEachDirection: nonce.length };
    };
    return await Promise.race([operation(), failure]);
  } catch { throw new Error("live_relay_payload_failed"); }
  finally {
    closed = true; clearTimeout(timer);
    let cleanupFailed = false;
    for (const remove of removeListeners) { try { remove(); } catch { cleanupFailed = true; } }
    for (const channel of channels) { try { channel.close(); } catch { cleanupFailed = true; } }
    for (const peer of peers) { try { peer.close(); } catch { cleanupFailed = true; } }
    if (cleanupFailed) throw new Error("live_relay_cleanup_failed");
  }
}
