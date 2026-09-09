import { isEligibleRelay } from "../../src/media-topology.js";

export function observeRelayConsent(registry) {
  const native = registry.setRelayConsent, rows = [];
  registry.setRelayConsent = function(peer, enabled, ...args) {
    const result = native.call(this, peer, enabled, ...args);
    if (rows.length < 16) rows.push({ member: this.members(peer.roomId).indexOf(peer), enabled: enabled === true });
    return result;
  };
  return () => rows.map(row => ({ ...row }));
}

export function installRelayInputObservation() {
  const changes = [], sent = [], errors = [], seen = new WeakSet();
  document.addEventListener("change", event => {
    if (event.target?.id === "relay-consent" && changes.length < 8) changes.push(event.target.checked === true);
  });
  const native = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    if (!seen.has(this)) {
      seen.add(this);
      this.addEventListener("message", event => {
        if (typeof event.data !== "string" || event.data.length > 1024 || errors.length >= 8) return;
        try {
          const value = JSON.parse(event.data);
          if (value.type === "error") errors.push(value.code === "rate_limited" ? "rate_limited" : "other");
        } catch { /* Ignore unrelated traffic. */ }
      });
    }
    if (typeof data === "string" && data.length < 256) {
      try {
        const value = JSON.parse(data);
        if (value.type === "relay-consent" && typeof value.enabled === "boolean" && sent.length < 8) sent.push(value.enabled);
      } catch { /* Never alter native transport validation. */ }
    }
    return native.call(this, data);
  };
  window.__relayInputObservation = () => ({ changes: [...changes], sent: [...sent], errors: [...errors] });
}

/** Failure-only counts/enums; no room/peer identities or capability payloads. */
export async function relayTopologyObservation(pages, members) {
  if (!Array.isArray(pages) || pages.length > 20 || !Array.isArray(members) || members.length > 20) {
    throw new Error("test_relay_observation_bounds");
  }
  const modes = await Promise.all(pages.map(async page => {
    try {
      const text = await page.locator("#topology-status").textContent({ timeout: 1000 });
      return /^(adaptive_mesh|trusted_peer_relay) · E\d+$/.exec(text?.trim())?.[1] || "unknown";
    } catch { return "unavailable"; }
  }));
  const inputs = await Promise.all(pages.map(async page => {
    try {
      const value = await page.evaluate(() => window.__relayInputObservation?.() ?? null);
      return value && Object.keys(value).sort().join() === "changes,errors,sent"
        && [value.changes, value.sent].every(rows => Array.isArray(rows) && rows.length <= 8 && rows.every(v => typeof v === "boolean"))
        && Array.isArray(value.errors) && value.errors.length <= 8 && value.errors.every(v => ["rate_limited", "other"].includes(v))
        ? value : null;
    }
    catch { return null; }
  }));
  return { members: members.length, consenting: members.filter(p => p.relayConsent === true).length,
    eligible: members.filter(p => isEligibleRelay(p)).length,
    hidden: members.filter(p => p.relayCapability?.visible === false).length,
    constrained: members.filter(p => p.relayCapability?.network === "constrained").length,
    lowCapacity: members.filter(p => Math.min(p.relayCapability?.selfCapacity ?? 50, p.relayCapability?.observedCapacity ?? 50) < 25).length,
    modes, inputs };
}
