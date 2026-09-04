import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rollout = JSON.parse(readFileSync(new URL("../infra/deployment/broadcast-rollout.v1.json", import.meta.url)));
const review = JSON.parse(readFileSync(new URL("../infra/security/broadcast-review.v1.json", import.meta.url)));

test("rollout remains disabled until every later-stage gate is real", () => {
  assert.equal(rollout.currentStage, "disabled");
  assert.equal(rollout.serverFeatureFlag.failClosed, true);
  assert.equal(rollout.stages.map(({ id }) => id).join(","), "disabled,internal,private-selected,public");
  assert.ok(Object.values(rollout.gateStatus).some((status) => !status.startsWith("verified")));
  assert.ok(rollout.killSwitch.length >= 5);
});

test("privacy review excludes media, captions, keys and grants from backup", () => {
  assert.equal(review.decision, "meet-approved-broadcast-disabled");
  assert.equal(review.recording, "not-implemented");
  assert.equal(review.transcriptRetention, "not-implemented");
  for (const value of ["media", "caption text", "ephemeral grants", "SFrame keys"]) {
    assert.ok(review.backupRestore.excluded.includes(value));
  }
  assert.ok(review.openFindings.length >= 4);
});
