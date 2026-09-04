import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const rollout = JSON.parse(read("infra/deployment/broadcast-rollout.v1.json"));
const review = JSON.parse(read("infra/security/broadcast-review.v1.json"));
const interop = JSON.parse(read("infra/testing/broadcast-interop-results.v1.json"));
const validation = JSON.parse(read("infra/testing/broadcast-validation-results.v1.json"));
const exampleEnv = read(".env.example");
const documentation = [
  "docs/broadcast-production-architecture.md",
  "docs/broadcast-user-help.md",
  "docs/broadcast-privacy-security-review.md",
  "docs/runbooks/broadcast-lifecycle-and-security.md",
].map(read).join("\n");

const stages = rollout.stages.map(({ id }) => id);
if (rollout.version !== 1 || JSON.stringify(stages) !== JSON.stringify(["disabled", "internal", "private-selected", "public"])) {
  throw new Error("invalid broadcast rollout stages");
}
if (!stages.includes(rollout.currentStage)) throw new Error("unknown current broadcast rollout stage");
if (rollout.serverFeatureFlag?.name !== "BROADCAST_WHIP_ENDPOINT"
  || rollout.serverFeatureFlag.disabledValue !== "" || rollout.serverFeatureFlag.failClosed !== true) {
  throw new Error("broadcast feature flag must fail closed");
}
if (!/^BROADCAST_WHIP_ENDPOINT=$/m.test(exampleEnv)) throw new Error("example environment must keep broadcast disabled");
if (rollout.killSwitch.length < 5 || !rollout.rollbackCommand.includes("production-deploy.sh rollback")) {
  throw new Error("broadcast kill switch or rollback is incomplete");
}

const verified = (status) => typeof status === "string" && status.startsWith("verified");
const current = rollout.stages.find(({ id }) => id === rollout.currentStage);
for (const gate of current.entryGates) {
  if (!verified(rollout.gateStatus[gate])) throw new Error(`current stage gate is not verified: ${gate}`);
}
const publicStage = rollout.stages.find(({ id }) => id === "public");
const publicReady = publicStage.entryGates.every((gate) => verified(rollout.gateStatus[gate]));
if (rollout.currentStage === "public" && !publicReady) throw new Error("public broadcast rollout is not authorized");
if (review.decision !== "meet-approved-broadcast-disabled" || review.recording !== "not-implemented"
  || review.transcriptRetention !== "not-implemented" || review.openFindings.length < 1) {
  throw new Error("privacy and security decision is not fail closed");
}
if (validation.soak.status === "not-executed" && verified(rollout.gateStatus["multi-hour-soak"])) {
  throw new Error("soak gate contradicts measured evidence");
}
const physicalSafari = interop.platforms.some(({ id, publish }) => id.includes("safari") && publish === "verified");
if (physicalSafari !== verified(rollout.gateStatus["physical-devices"])) {
  throw new Error("physical-device gate contradicts interoperability evidence");
}
for (const term of ["Own Source", "Trusted Program", "SFrame", "LL-HLS", "Consent", "Kill-Switch", "Außerbetriebnahme"]) {
  if (!documentation.includes(term)) throw new Error(`broadcast release documentation is incomplete: ${term}`);
}

process.stdout.write(`Validated broadcast rollout: current=${rollout.currentStage}, publicReady=${publicReady}.\n`);
