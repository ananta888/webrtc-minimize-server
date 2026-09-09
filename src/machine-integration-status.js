import { MACHINE_CAPABILITIES, machineCapabilityCeiling } from "./machine-capabilities.js";

/** Public software/configuration observation. Never a grant or Hub heartbeat. */
export function machineIntegrationStatus(admissionEnabled, allowedCapabilities) {
  if (typeof admissionEnabled !== "boolean") throw new Error("machine_integration_invalid");
  return Object.freeze({
    schema: "ananta.meet-integration.v1",
    admissionEnabled,
    supportedCapabilities: machineCapabilityCeiling(MACHINE_CAPABILITIES),
    operatorCapabilityCeiling: machineCapabilityCeiling(allowedCapabilities),
    publisherConsentRequired: Object.freeze(["audio.receive", "chat.read", "video.receive"]),
    sessionLease: "ananta.meet-session-lease.v1",
  });
}
