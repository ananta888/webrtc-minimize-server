// Read-only Playwright signaling observer. Retains no peer IDs, payloads,
// room codes, SDP, ICE, URLs or arbitrary server error strings.
export function observeMachineSourceMembership(page) {
  const events = [], started = performance.now(); let truncated = false;
  const record = value => {
    if (events.length >= 32) { truncated = true; return; }
    events.push({ ...value, elapsedMs: Math.min(120000, Math.max(0, Math.floor(performance.now() - started))) });
  };
  const attach = socket => {
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string" || payload.length > 65536) return;
      let value; try { value = JSON.parse(payload); } catch { return; }
      if (value?.type === "topology-state" && Number.isSafeInteger(value.membershipEpoch) && value.membershipEpoch >= 0
        && value.membershipEpoch <= 1000000 && Array.isArray(value.peers) && value.peers.length <= 20) {
        record({ kind: "membership", epoch: value.membershipEpoch, peers: value.peers.length });
      } else if (["peer-left", "peer-joined"].includes(value?.type)) record({ kind: value.type });
      else if (value?.type === "error") record({ kind: "error", code: value.code === "rate_limited" ? "rate_limited" : "other" });
    });
    socket.on("close", () => record({ kind: "closed" }));
  };
  page.on("websocket", attach);
  return () => ({ events: events.map(value => ({ ...value })), truncated });
}
