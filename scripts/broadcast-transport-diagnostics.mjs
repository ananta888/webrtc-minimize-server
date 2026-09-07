// Serialized into an explicitly isolated test browser, never installed by the app.
export function installBroadcastTransportDiagnostics() {
  window.__broadcastGateTransportStats = [];
  const started = new WeakMap();
  let sampling = false;
  const enumValue = (value, allowed) => allowed.includes(value) ? value : "unknown";
  const count = value => Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : 0;
  setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      const peers = (window.__broadcastGateConnections || []).filter(pc => pc.connectionState !== "closed").slice(-3);
      if (!peers.length) return;
      const sample = [];
      for (const pc of peers) {
        if (!started.has(pc)) started.set(pc, performance.now());
        const snapshot = {
          ageMs: count(performance.now() - started.get(pc)),
          connection: enumValue(pc.connectionState, ["new", "connecting", "connected", "disconnected", "failed"]),
          ice: enumValue(pc.iceConnectionState, ["new", "checking", "connected", "completed", "disconnected", "failed"]),
          gathering: enumValue(pc.iceGatheringState, ["new", "gathering", "complete"]),
          signaling: enumValue(pc.signalingState, ["stable", "have-local-offer", "have-remote-offer"]),
          localDescription: Boolean(pc.localDescription), remoteDescription: Boolean(pc.remoteDescription),
          rtp: [], transports: [], candidates: {}, pairs: {},
        };
        const stats = await pc.getStats();
        let examined = 0;
        for (const item of stats.values()) {
          if (++examined > 512) break;
          if (item.type === "outbound-rtp" && snapshot.rtp.length < 4) snapshot.rtp.push({
            kind: enumValue(item.kind, ["audio", "video"]), bytes: count(item.bytesSent),
            packets: count(item.packetsSent), frames: count(item.framesEncoded), fps: count(item.framesPerSecond),
            qualityLimitation: enumValue(item.qualityLimitationReason, ["none", "cpu", "bandwidth", "other"]),
          });
          if (item.type === "transport" && snapshot.transports.length < 2) snapshot.transports.push({
            dtls: enumValue(item.dtlsState, ["new", "connecting", "connected", "closed", "failed"]),
            sent: count(item.bytesSent), received: count(item.bytesReceived),
          });
          if (["local-candidate", "remote-candidate"].includes(item.type)) {
            const key = `${item.type}:${enumValue(item.candidateType, ["host", "srflx", "prflx", "relay"])}:${enumValue(item.protocol, ["udp", "tcp"])}`;
            snapshot.candidates[key] = (snapshot.candidates[key] || 0) + 1;
          }
          if (item.type === "candidate-pair") {
            const key = enumValue(item.state, ["frozen", "waiting", "in-progress", "failed", "succeeded"]);
            snapshot.pairs[key] = (snapshot.pairs[key] || 0) + 1;
          }
        }
        sample.push(snapshot);
      }
      window.__broadcastGateTransportStats.push(sample);
      if (window.__broadcastGateTransportStats.length > 8) window.__broadcastGateTransportStats.shift();
    } catch { /* A test-owned peer may close while sampling. */ }
    finally { sampling = false; }
  }, 2_000);
}
