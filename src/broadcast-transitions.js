import {
  BROADCAST_CONTRACT_IDENTITY_FIELDS,
  BroadcastContractError,
  validateBroadcastContract,
} from "./broadcast-contracts.js";

const STATE_FIELD = Object.freeze({
  "broadcast-program": "state",
  "program-source": "state",
  publication: "state",
  rendition: "state",
  "delivery-endpoint": "state",
  consent: "status",
  lease: "status",
  grant: "status",
  "caption-track": "state",
});

const transitionSet = (mapping) => Object.freeze(Object.fromEntries(
  Object.entries(mapping).map(([state, targets]) => [state, new Set(targets)]),
));

const TRANSITIONS = Object.freeze({
  "broadcast-program": transitionSet({
    draft: ["preparing", "stopped"],
    preparing: ["awaiting_consent", "publishing", "stopping", "failed"],
    awaiting_consent: ["publishing", "stopping", "failed"],
    publishing: ["live", "degraded", "stopping", "failed"],
    live: ["degraded", "stopping", "failed"],
    degraded: ["live", "publishing", "stopping", "failed"],
    stopping: ["stopped", "failed"],
    failed: ["preparing", "stopped"],
    stopped: [],
  }),
  "program-source": transitionSet({
    selected: ["active", "ended", "revoked"],
    active: ["ended", "revoked"],
    ended: [],
    revoked: [],
  }),
  publication: transitionSet({
    planned: ["starting", "stopped"],
    starting: ["live", "stopping", "failed"],
    live: ["stopping", "failed"],
    stopping: ["stopped", "failed"],
    failed: ["starting", "stopped"],
    stopped: [],
  }),
  rendition: transitionSet({
    planned: ["active", "stopped", "failed"],
    active: ["degraded", "stopped", "failed"],
    degraded: ["active", "stopped", "failed"],
    failed: ["active", "stopped"],
    stopped: [],
  }),
  "delivery-endpoint": transitionSet({
    provisioning: ["ready", "stopped", "failed"],
    ready: ["active", "draining", "stopped", "failed"],
    active: ["draining", "stopped", "failed"],
    draining: ["stopped", "failed"],
    failed: ["provisioning", "stopped"],
    stopped: [],
  }),
  consent: transitionSet({ active: ["revoked", "expired"], revoked: [], expired: [] }),
  lease: transitionSet({ active: ["released", "expired", "lost"], released: [], expired: [], lost: [] }),
  grant: transitionSet({ issued: ["consumed", "revoked", "expired"], consumed: [], revoked: [], expired: [] }),
  "caption-track": transitionSet({
    planned: ["active", "stopped", "failed"],
    active: ["stopped", "failed"],
    failed: ["active", "stopped"],
    stopped: [],
  }),
});

function fail(code) {
  throw new BroadcastContractError(code);
}

export function assertBroadcastTransition(previousValue, nextValue, context = {}, now = Date.now()) {
  const previous = validateBroadcastContract(previousValue, { ...context, requireFresh: false }, now);
  const next = validateBroadcastContract(nextValue, { ...context, requireFresh: false }, now);
  if (previous.type !== next.type || !STATE_FIELD[previous.type]) {
    fail("unsupported_broadcast_transition");
  }
  const identityField = BROADCAST_CONTRACT_IDENTITY_FIELDS[previous.type];
  for (const field of [identityField, "tenantId", "roomId", "programId", "programEpoch"]) {
    if (previous[field] !== next[field]) fail("broadcast_transition_binding_mismatch");
  }
  if (next.revision !== previous.revision + 1) fail("stale_broadcast_revision");
  if (previous.updatedAt !== undefined && next.updatedAt < previous.updatedAt) {
    fail("stale_broadcast_update");
  }
  const stateField = STATE_FIELD[previous.type];
  const before = previous[stateField];
  const after = next[stateField];
  if (before !== after && !TRANSITIONS[previous.type][before].has(after)) {
    fail("invalid_broadcast_transition");
  }
  return next;
}
