import { machineCapabilityCeiling } from "./machine-capabilities.js";
import { MACHINE_GRANT_AUDIENCES } from "./machine-trust-profile.js";

const fields = ["schema", "meetRevision", "hubRevision", "publicOrigin", "hubIssuer", "hubKeySha256",
  "tenantId", "projectId", "roomId", "capabilities"];
const v2Fields = [...fields, "trustRevision", "keyId", "subject", "audience", "grantTtlSeconds"];
const id = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);

export function machineHttpsOrigin(value) {
  try { const url = new URL(value); return typeof value === "string" && url.protocol === "https:"
    && !url.username && !url.password && url.origin === value; } catch { return false; }
}
export function machineHttpsIssuer(value) {
  try { const url = new URL(value); return typeof value === "string" && url.protocol === "https:"
    && !url.username && !url.password && !url.search && !url.hash && !/[\s|]/.test(value); } catch { return false; }
}

/** A closed local expectation, never an operator grant or release evidence. */
export function parseMachineRolloutPlan(value) {
  const v2 = value?.schema === "ananta.meet-rollout-plan.v2", allowed = v2 ? v2Fields : fields;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key))
    || !["ananta.meet-rollout-plan.v1", "ananta.meet-rollout-plan.v2"].includes(value.schema)
    || ![value.meetRevision, value.hubRevision].every(v => typeof v === "string" && /^[a-f0-9]{40}$/.test(v))
    || !machineHttpsOrigin(value.publicOrigin) || !machineHttpsIssuer(value.hubIssuer)
    || typeof value.hubKeySha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.hubKeySha256)
    || ![value.tenantId, value.projectId].every(id)
    || typeof value.roomId !== "string" || !/^room-[a-f0-9]{18}$/.test(value.roomId)
    || !Array.isArray(value.capabilities) || !value.capabilities.length) throw new Error("machine_rollout_plan_invalid");
  if (v2 && (!Number.isSafeInteger(value.trustRevision) || value.trustRevision < 1
    || typeof value.keyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.keyId)
    || !id(value.subject) || !MACHINE_GRANT_AUDIENCES.includes(value.audience)
    || !Number.isSafeInteger(value.grantTtlSeconds) || value.grantTtlSeconds < 1 || value.grantTtlSeconds > 600)) {
    throw new Error("machine_rollout_plan_invalid");
  }
  return Object.freeze({ ...value, capabilities: machineCapabilityCeiling(value.capabilities) });
}
