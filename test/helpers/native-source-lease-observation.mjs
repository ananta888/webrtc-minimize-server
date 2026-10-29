const stopCodes = new Set(["SOURCE_AUTHORITY_LOST", "SOURCE_CONTROL_CLOSED",
  "CONTROL_DELIVERY_FAILED", "PUBLISHER_DELIVERY_FAILED", "SOURCE_SIGNAL_DELIVERY_FAILED",
  "SOURCE_REVISION_LIMIT", "SOURCE_RECEIVER_FAILED", "SOURCE_SIGNAL_CAPABILITY_LOST",
  "SOURCE_CONSENT_EXPIRED"]);
const positive = value => Number.isSafeInteger(value) && value > 0;
const remaining = (deadline, now) => Math.max(-600000, Math.min(600000, deadline - now));

/** Private test observation only: never retain identities or authority objects. */
export function recordSourceLease(rows, value, now) {
  if (!positive(now) || value?.version !== 1) return;
  let row;
  if (value.type === "trusted-source-publisher-lease") {
    const lease = value.lease;
    if (!positive(lease?.revision) || !positive(lease.expiresAt) || !positive(lease.consent?.expiresAt)) return;
    row = { outcome: "lease", revision: lease.revision, remainingMs: remaining(lease.expiresAt, now),
      consentRemainingMs: remaining(lease.consent.expiresAt, now) };
  } else if (value.type === "trusted-source-publisher-stop") {
    if (!positive(value.leaseRevision) || !positive(value.expiresAt) || !stopCodes.has(value.reasonCode)) return;
    row = { outcome: "stop", revision: value.leaseRevision, remainingMs: remaining(value.expiresAt, now), code: value.reasonCode };
  } else return;
  rows.push(Object.freeze(row));
  if (rows.length > 32) rows.shift();
}
