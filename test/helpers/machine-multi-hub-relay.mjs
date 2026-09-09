// Closed private bridge selection and bounded aggregate observations, not grants.
import { machineRelayObservation } from "./machine-relay-observation.js";

export function multiHubIcePath(value = "direct") {
  if (!["direct", "turn-udp", "turn-tcp"].includes(value)) throw new Error("test_multi_ice_path_invalid");
  return value;
}

export function multiRelayMatches(value, expected, transport, previous) {
  if (![1, 2].includes(expected) || !["udp", "tcp"].includes(transport)) throw new Error("test_multi_relay_scope_invalid");
  const fields = ["connections", "sctpConnections", "pairs", "relayPairs", "policyFailures",
    "sent", "received", "udp", "tcp", "unknownProtocol"];
  if (!value || Object.keys(value).sort().join() !== [...fields].sort().join()
    || fields.some(field => !Number.isSafeInteger(value[field]) || value[field] < 0)) return false;
  return value.connections === expected && value.sctpConnections === expected
    && value.pairs === expected && value.relayPairs === expected && value.policyFailures === 0
    && value.udp + value.tcp + value.unknownProtocol === expected
    && value[transport === "udp" ? "tcp" : "udp"] === 0
    && value.sent > (previous?.sent || 0) && value.received > (previous?.received || 0);
}

export async function observeMultiHubRelay(page, expected, transport) {
  let stopped = false, timer;
  const poll = async () => {
    let previous;
    while (!stopped) {
      const value = await machineRelayObservation(page);
      if (multiRelayMatches(value, expected, transport)) {
        if (previous && multiRelayMatches(value, expected, transport, previous)) return value;
        previous = value;
      } else previous = undefined;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  try {
    return await Promise.race([poll(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("test_multi_relay_observation_deadline")), 1500);
    })]);
  } finally { stopped = true; clearTimeout(timer); }
}
