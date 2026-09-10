import { NativeSourceSceneError } from "./native-source-scene-broker.js";
import { nativeSceneAuthorizer } from "./native-source-scene-director.js";

const fail = (code, status = 409) => { throw new NativeSourceSceneError(code, status); };
const ref = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`).test(value);
const positive = n => Number.isSafeInteger(n) && n > 0;
export function normalizeNativeSourceLabelsInput(value) {
  const fields = ["requestVersion", "deviceFingerprint", "expectedProgramRevision", "expectedProgramEpoch",
    "expectedPackagerId", "expectedAssignmentId", "expectedFencingRevision", "sourceLeaseIds"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length
    || Object.keys(value).some(k => !fields.includes(k)) || value.requestVersion !== 1
    || typeof value.deviceFingerprint !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceFingerprint)
    || !positive(value.expectedProgramRevision) || !positive(value.expectedProgramEpoch) || !positive(value.expectedFencingRevision)
    || !ref(value.expectedPackagerId, "pkr") || !ref(value.expectedAssignmentId, "asn")
    || !Array.isArray(value.sourceLeaseIds) || value.sourceLeaseIds.length > 80
    || value.sourceLeaseIds.some(id => !ref(id, "sls")) || new Set(value.sourceLeaseIds).size !== value.sourceLeaseIds.length) {
    fail("invalid_native_source_labels_request", 400);
  }
  return Object.freeze({ ...value, sourceLeaseIds: Object.freeze([...value.sourceLeaseIds]) });
}

/** Metadata-only projection. Budgets die with actual membership objects; no identity cache or native command. */
export class NativeSourceLabels {
  #budgets = new WeakMap();
  #closed = false;
  constructor({ clock = Date.now } = {}) { this.clock = clock; }
  query({ input: raw, sources, ...ports }) {
    if (this.#closed || !sources) fail("native_source_labels_unavailable", 503);
    const input = normalizeNativeSourceLabelsInput(raw), member = ports.getMember(), now = this.clock();
    if (!member || member.machine || member.principal !== ports.ownerPrincipal || member.deviceFingerprint !== input.deviceFingerprint) {
      fail("native_scene_controller_required", 403);
    }
    const budget = this.#budgets.get(member);
    if (!positive(now) || budget && now < budget.last) fail("native_source_labels_clock_invalid");
    if (budget && now - budget.start < 10000) {
      budget.last = now;
      if (budget.count >= 20) fail("native_source_labels_rate_limited", 429);
      budget.count++;
    } else this.#budgets.set(member, { start: now, last: now, count: 1 });
    const context = nativeSceneAuthorizer({ ...ports, getMember: () => member,
      input: { ...input, action: "query" } })(now);
    if (context.packagerId !== input.expectedPackagerId || context.assignmentId !== input.expectedAssignmentId
      || context.fencingRevision !== input.expectedFencingRevision) fail("native_source_labels_scope_changed");
    const bindings = sources.publisherBindings({ roomId: member.roomId, programId: context.programId,
      programEpoch: context.programEpoch, packagerId: context.packagerId, assignmentId: context.assignmentId,
      writerLeaseId: context.leaseId, fencingRevision: context.fencingRevision }, input.sourceLeaseIds);
    return Object.freeze({ version: 1, programId: context.programId, programRevision: context.programRevision,
      programEpoch: context.programEpoch, packagerId: context.packagerId, assignmentId: context.assignmentId,
      fencingRevision: context.fencingRevision, bindings });
  }
  destroy() { this.#closed = true; this.#budgets = new WeakMap(); }
}
