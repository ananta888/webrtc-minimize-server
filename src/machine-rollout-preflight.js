import { machineCapabilityCeiling } from "./machine-capabilities.js";
import { machineHttpsOrigin, parseMachineRolloutPlan } from "./machine-rollout-plan.js";
import { checkMachineRolloutTrust } from "./machine-rollout-trust.js";
export { parseMachineRolloutPlan } from "./machine-rollout-plan.js";

/** Local read-only diagnostics, NOT an admission decision or external attestation. */
export function machineRolloutPreflight({ plan: input, config, revision, clean, now = Date.now() }) {
  const plan = parseMachineRolloutPlan(input), checks = [];
  const check = (code, success) => checks.push(Object.freeze({ code, status: success ? "pass" : "fail" }));
  check("meet_revision_matches", revision === plan.meetRevision);
  check("meet_worktree_clean", clean === true);
  check("https_origin_matches", machineHttpsOrigin(config.publicOrigin) && config.publicOrigin === plan.publicOrigin);
  check("human_oidc_required", config.authMode === "required");
  check("sframe_required", config.mediaE2eeMode === "required");
  checkMachineRolloutTrust(plan, config, now, check);
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
