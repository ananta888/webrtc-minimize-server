import assert from "node:assert/strict";

/** Observe selected data-bearing transports, not merely gathered candidates. */
export async function machineRelayObservation(page) {
  return page.evaluate(async () => {
    const active = window.__pcs.filter(pc => pc.connectionState === "connected");
    const result = { connections: active.length, sctpConnections: active.filter(pc => pc.sctp?.state === "connected").length,
      pairs: 0, relayPairs: 0, policyFailures: 0,
      sent: 0, received: 0, udp: 0, tcp: 0, unknownProtocol: 0 };
    for (const pc of active) {
      if (pc.getConfiguration().iceTransportPolicy !== "relay") result.policyFailures++;
      const stats = await pc.getStats();
      const selected = new Set([...stats.values()].filter(s => s.type === "transport" && s.selectedCandidatePairId)
        .map(s => s.selectedCandidatePairId));
      const connectedSelected = new Set([...stats.values()].filter(s => s.type === "transport"
        && s.dtlsState === "connected" && s.selectedCandidatePairId).map(s => s.selectedCandidatePairId));
      for (const pair of stats.values()) {
        if (pair.type !== "candidate-pair"
          || !(selected.size ? selected.has(pair.id) : pair.selected === true || pair.nominated === true)) continue;
        // Chromium can report an ongoing check on the already selected TCP
        // relay while ICE/DTLS/SCTP and actual payload transport remain active.
        // This is not permission to count an unselected or failed candidate.
        const activeCheck = pair.state === "in-progress" && connectedSelected.has(pair.id)
          && ["connected", "completed"].includes(pc.iceConnectionState)
          && pc.sctp?.state === "connected" && pc.sctp?.transport?.state === "connected"
          && Number.isFinite(pair.bytesSent) && pair.bytesSent > 0
          && Number.isFinite(pair.bytesReceived) && pair.bytesReceived > 0;
        if (pair.state !== "succeeded" && !activeCheck) continue;
        result.pairs++;
        const local = stats.get(pair.localCandidateId);
        if (local?.candidateType === "relay") result.relayPairs++;
        if (local?.relayProtocol === "udp") result.udp++;
        else if (local?.relayProtocol === "tcp") result.tcp++;
        else result.unknownProtocol++;
        result.sent += Number(pair.bytesSent || 0); result.received += Number(pair.bytesReceived || 0);
      }
    }
    return result;
  });
}

export async function waitMachineRelaySetup(pages, timeoutMs = 25_000) {
  if (![1500, 25_000].includes(timeoutMs)) throw new Error("test_relay_observation_budget_invalid");
  let cancelled = false, timer;
  const poll = async () => {
    while (!cancelled) {
      const observations = await Promise.all(pages.map(machineRelayObservation));
      if (observations.every(v => v.connections === 1 && v.sctpConnections === 1
        && v.pairs === 1 && v.relayPairs === 1 && v.policyFailures === 0)) return observations;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  try {
    return await Promise.race([poll(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("test_relay_setup_deadline")), timeoutMs);
    })]);
  } finally { cancelled = true; clearTimeout(timer); }
}

export async function machineRelayDiagnostics(page) {
  return page.evaluate(async () => ({ iceEvents: window.__testIce,
    peers: await Promise.all(window.__pcs.slice(0, 2).map(async pc => ({
      connection: pc.connectionState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState,
      signaling: pc.signalingState, sctp: pc.sctp?.state, dtls: pc.sctp?.transport?.state,
      localType: pc.localDescription?.type, remoteType: pc.remoteDescription?.type,
      localMedia: (pc.localDescription?.sdp.match(/^m=(audio|video|application)/gm) || []).slice(0, 8),
      remoteMedia: (pc.remoteDescription?.sdp.match(/^m=(audio|video|application)/gm) || []).slice(0, 8),
      stats: [...(await pc.getStats()).values()].filter(s => s.type === "transport" || s.type === "candidate-pair")
        .slice(0, 16).map(s => ({ type: s.type, state: s.state, dtls: s.dtlsState, selected: s.selected,
          nominated: s.nominated, sent: s.bytesSent, received: s.bytesReceived })),
    }))),
  }));
}

export function assertMachineRelayObservation(value, transport, previous) {
  assert.equal(value.connections, 1, "one connected room counterpart");
  assert.equal(value.pairs, 1, "one selected connected data-bearing ICE pair");
  assert.equal(value.relayPairs, 1, "the selected local candidate is relay");
  assert.equal(value.policyFailures, 0, "relay policy survived configuration updates");
  assert.equal(transport === "udp" ? value.tcp : value.udp, 0, "reported relay protocol matches isolated listener");
  assert.ok(value.sent > (previous?.sent || 0) && value.received > (previous?.received || 0), "relay carries data in both directions");
}
