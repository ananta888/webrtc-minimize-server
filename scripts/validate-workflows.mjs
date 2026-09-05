import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowDirectory = path.join(root, ".github", "workflows");
const workflowNames = (await fs.readdir(workflowDirectory))
  .filter((name) => /\.ya?ml$/.test(name))
  .sort();

if (workflowNames.length === 0) throw new Error("No GitHub Actions workflows found");

for (const workflowName of workflowNames) {
  const source = await fs.readFile(path.join(workflowDirectory, workflowName), "utf8");
  const document = parseDocument(source, { uniqueKeys: true, prettyErrors: true });
  if (document.errors.length) {
    throw new Error(`${workflowName}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  const workflow = document.toJS();
  const triggers = workflow.on || {};
  for (const trigger of ["push", "pull_request", "workflow_dispatch"]) {
    if (!Object.hasOwn(triggers, trigger)) throw new Error(`${workflowName}: missing ${trigger} trigger`);
  }
  if (Object.hasOwn(triggers, "pull_request_target")) {
    throw new Error(`${workflowName}: pull_request_target is forbidden for untrusted code`);
  }
  if (workflow.permissions?.contents !== "read" || Object.keys(workflow.permissions).length !== 1) {
    throw new Error(`${workflowName}: workflow permissions must be exactly contents: read`);
  }
  if (!workflow.jobs?.test || !workflow.jobs?.docker || workflow.jobs.docker.needs !== "test") {
    throw new Error(`${workflowName}: test and dependent docker jobs are required`);
  }
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (job.permissions) {
      const allowed = jobName === "native-packager"
        && job.permissions.contents === "read"
        && job.permissions["id-token"] === "write"
        && job.permissions.attestations === "write"
        && Object.keys(job.permissions).length === 3;
      if (!allowed) throw new Error(`${workflowName}: ${jobName} has unexpected elevated permissions`);
    }
    for (const step of job.steps || []) {
      if (step.uses && !/^actions\/(?:checkout|setup-node|setup-go|upload-artifact|attest-build-provenance)@[0-9a-f]{40}$/.test(step.uses)) {
        throw new Error(`${workflowName}: ${jobName} uses an unpinned or unapproved action: ${step.uses}`);
      }
    }
  }
}

console.log(`Validated ${workflowNames.length} GitHub Actions workflow.`);
