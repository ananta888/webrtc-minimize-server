import { createHash, createPublicKey } from "node:crypto";
import { machineCapabilityCeiling } from "./machine-capabilities.js";

const fields = ["schema", "meetRevision", "hubRevision", "publicOrigin", "hubIssuer", "hubKeySha256",
  "tenantId", "projectId", "roomId", "capabilities"];
const id = /^[A-Za-z0-9_.:-]{1,160}$/;
function httpsOrigin(value) {
  try { const url = new URL(value); return typeof value === "string" && url.protocol === "https:"
    && !url.username && !url.password && url.origin === value; } catch { return false; }
}
function httpsIssuer(value) {
  try { const url = new URL(value); return typeof value === "string" && url.protocol === "https:"
    && !url.username && !url.password && !url.search && !url.hash && !/[\s|]/.test(value); } catch { return false; }
}
export function parseMachineRolloutPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))
    || value.schema !== "ananta.meet-rollout-plan.v1"
    || ![value.meetRevision, value.hubRevision].every(v => typeof v === "string" && /^[a-f0-9]{40}$/.test(v))
    || !httpsOrigin(value.publicOrigin) || !httpsIssuer(value.hubIssuer)
    || typeof value.hubKeySha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.hubKeySha256)
    || ![value.tenantId, value.projectId].every(v => typeof v === "string" && id.test(v))
    || typeof value.roomId !== "string" || !/^room-[a-f0-9]{18}$/.test(value.roomId)
    || !Array.isArray(value.capabilities) || !value.capabilities.length) throw new Error("machine_rollout_plan_invalid");
  return Object.freeze({ ...value, capabilities: machineCapabilityCeiling(value.capabilities) });
}

/** Local read-only diagnostics, NOT an admission decision or external attestation. */
export function machineRolloutPreflight({ plan: input, config, revision, clean }) {
  const plan = parseMachineRolloutPlan(input), checks = [];
  const check = (code, success) => checks.push(Object.freeze({ code, status: success ? "pass" : "fail" }));
  check("meet_revision_matches", revision === plan.meetRevision);
  check("meet_worktree_clean", clean === true);
  check("https_origin_matches", httpsOrigin(config.publicOrigin) && config.publicOrigin === plan.publicOrigin);
  check("human_oidc_required", config.authMode === "required");
  check("sframe_required", config.mediaE2eeMode === "required");
  check("hub_issuer_matches", httpsIssuer(config.machineHubIssuer) && config.machineHubIssuer === plan.hubIssuer);
  let fingerprint = "";
  try {
    // Never accept a private key or include key material in diagnostics.
    if (typeof config.machineHubPublicKey === "string" && config.machineHubPublicKey.length <= 4096
      && config.machineHubPublicKey.trim().startsWith("-----BEGIN PUBLIC KEY-----")) {
      const key = createPublicKey(config.machineHubPublicKey);
      if (key.asymmetricKeyType === "ed25519") fingerprint = createHash("sha256")
        .update(key.export({ type: "spki", format: "der" })).digest("hex");
    }
  } catch { /* Fixed check code, never raw parser errors. */ }
  check("ed25519_hub_key_matches", fingerprint === plan.hubKeySha256);
  let ceiling = [];
  try { ceiling = machineCapabilityCeiling(config.machineAllowedCapabilities); } catch { /* Deny invalid config. */ }
  check("capabilities_within_operator_ceiling", plan.capabilities.every(cap => ceiling.includes(cap)));
  // Accepting a plan's syntax does not verify the external Hub's deployed revision,
  // current TaskQueue/project policy, room membership, source consent or test evidence.
  for (const code of ["hub_revision_and_contract_evidence", "current_hub_task_policy", "current_room_and_publisher_consent",
    "browser_agent_turn_and_soak_acceptance", "operator_rollout_authorization"]) {
    checks.push(Object.freeze({ code, status: "unverified" }));
  }
  const localReady = checks.every(c => c.status !== "fail");
  return Object.freeze({ schema: "ananta.meet-rollout-preflight.v1", status: localReady ? "local_ready" : "blocked",
    localReady, productionReady: false, checks: Object.freeze(checks) });
}
