import { createHash, createPublicKey } from "node:crypto";
import { machineHttpsIssuer } from "./machine-rollout-plan.js";
import { machineTrustScopeAllows, parseMachineTrustProfile } from "./machine-trust-profile.js";

function fingerprint(key) {
  return key?.asymmetricKeyType === "ed25519"
    ? createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex") : "";
}

function legacyChecks(plan, config, check) {
  check("machine_trust_mode_matches", !config.machineHubTrustProfile);
  check("hub_issuer_matches", machineHttpsIssuer(config.machineHubIssuer) && config.machineHubIssuer === plan.hubIssuer);
  let actual = "";
  try {
    if (typeof config.machineHubPublicKey === "string" && config.machineHubPublicKey.length <= 4096
      && config.machineHubPublicKey.trim().startsWith("-----BEGIN PUBLIC KEY-----")) {
      actual = fingerprint(createPublicKey(config.machineHubPublicKey));
    }
  } catch { /* Never expose raw key-parser errors. */ }
  check("ed25519_hub_key_matches", actual === plan.hubKeySha256);
}

/** Closed boolean checks only; the plan does not supply authority or keys. */
export function checkMachineRolloutTrust(plan, config, now, check) {
  if (plan.schema === "ananta.meet-rollout-plan.v1") return legacyChecks(plan, config, check);
  check("machine_trust_mode_matches", Boolean(config.machineHubTrustProfile)
    && !config.machineHubPublicKey && !config.machineHubIssuer);
  let profile;
  try { profile = parseMachineTrustProfile(config.machineHubTrustProfile); } catch { /* Deny invalid configuration. */ }
  check("machine_trust_profile_valid", Boolean(profile));
  check("machine_trust_revision_matches", profile?.revision === plan.trustRevision);
  check("hub_issuer_matches", profile?.issuer === plan.hubIssuer);
  check("machine_trust_audience_allowed", profile?.audiences.includes(plan.audience) === true);
  const selected = profile?.keys.find(key => key.kid === plan.keyId);
  check("machine_trust_key_selected", Boolean(selected));
  const clockValid = Number.isSafeInteger(now) && now >= 0 && now <= 8640000000000000;
  check("machine_trust_key_window", Boolean(selected) && clockValid && now / 1000 >= selected.notBefore
    && now / 1000 < selected.notAfter && Math.floor(now / 1000) + plan.grantTtlSeconds <= selected.notAfter);
  let actual = "";
  try { if (selected) actual = fingerprint(createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: selected.x }, format: "jwk",
  })); } catch { /* Never expose public/private material or parser errors. */ }
  check("ed25519_hub_key_matches", actual === plan.hubKeySha256);
  check("machine_trust_scope_allowed", Boolean(profile) && machineTrustScopeAllows(profile,
    { sub: plan.subject, tenantId: plan.tenantId, projectId: plan.projectId }, plan.capabilities));
  check("machine_grant_capability_shape", plan.audience !== "ananta-meet-machine-v1"
    || plan.capabilities.join(",") === "avatar.publish,chat.send,speech.publish");
}
