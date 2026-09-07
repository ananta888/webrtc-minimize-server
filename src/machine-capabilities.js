export const MACHINE_CAPABILITIES = Object.freeze(["audio.receive", "chat.read", "chat.send",
  "screen.publish", "screen-audio.publish", "avatar.publish", "speech.publish"]);

/** An operator ceiling, never a source of task or publisher authorization. Empty denies all. */
export function machineCapabilityCeiling(value = MACHINE_CAPABILITIES) {
  if (!Array.isArray(value) || value.length > MACHINE_CAPABILITIES.length
    || new Set(value).size !== value.length || value.some(cap => !MACHINE_CAPABILITIES.includes(cap))) {
    throw new Error("machine_capability_ceiling_invalid");
  }
  return Object.freeze([...value].sort());
}

export function machineCapabilityEnvironment(value) {
  if (value === undefined) return machineCapabilityCeiling();
  if (typeof value !== "string" || value.length > 200) throw new Error("machine_capability_ceiling_invalid");
  return machineCapabilityCeiling(value.trim() === "" ? [] : value.split(",").map(cap => cap.trim()));
}
