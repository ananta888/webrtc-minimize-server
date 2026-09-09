export const MACHINE_INTEGRATION_CAPABILITIES = ["audio.receive", "avatar.publish", "chat.read", "chat.send",
  "screen-audio.publish", "screen.publish", "speech.publish", "video.receive"] as const;
export type MachineIntegrationCapability = typeof MACHINE_INTEGRATION_CAPABILITIES[number];
export interface MachineIntegrationStatus {
  readonly schema: "ananta.meet-integration.v1";
  readonly admissionEnabled: boolean;
  readonly supportedCapabilities: readonly MachineIntegrationCapability[];
  readonly operatorCapabilityCeiling: readonly MachineIntegrationCapability[];
  readonly publisherConsentRequired: readonly MachineIntegrationCapability[];
  readonly sessionLease: "ananta.meet-session-lease.v1";
}

/** Closed observation contract; these lists never authorize a source or a join. */
export function parseMachineIntegration(value: unknown): MachineIntegrationStatus {
  const fail = (): never => { throw new Error("machine_integration_invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  const fields = ["schema", "admissionEnabled", "supportedCapabilities", "operatorCapabilityCeiling", "publisherConsentRequired", "sessionLease"];
  if (Object.keys(v).length !== fields.length || Object.keys(v).some(key => !fields.includes(key))
    || v["schema"] !== "ananta.meet-integration.v1" || typeof v["admissionEnabled"] !== "boolean"
    || v["sessionLease"] !== "ananta.meet-session-lease.v1") return fail();
  const caps = (input: unknown): readonly MachineIntegrationCapability[] => {
    if (!Array.isArray(input) || input.length > 8 || new Set(input).size !== input.length
      || input.some(item => !MACHINE_INTEGRATION_CAPABILITIES.includes(item))
      || input.some((item, index) => index > 0 && input[index - 1] >= item)) return fail();
    return Object.freeze([...input]);
  };
  const supported = caps(v["supportedCapabilities"]), ceiling = caps(v["operatorCapabilityCeiling"]);
  const consent = caps(v["publisherConsentRequired"]);
  if (supported.join(",") !== MACHINE_INTEGRATION_CAPABILITIES.join(",")
    || consent.join(",") !== "audio.receive,chat.read,video.receive"
    || v["admissionEnabled"] && ceiling.length === 0) return fail();
  return Object.freeze({ schema: "ananta.meet-integration.v1", admissionEnabled: v["admissionEnabled"],
    supportedCapabilities: supported, operatorCapabilityCeiling: ceiling, publisherConsentRequired: consent,
    sessionLease: "ananta.meet-session-lease.v1" });
}
