import {
  BroadcastContractError,
  broadcastContractId,
  validateBroadcastContract,
} from "./broadcast-contracts.js";

export const MAX_BROADCAST_AGGREGATE_ITEMS = 128;

function fail(code) {
  throw new BroadcastContractError(code);
}

function indexContracts(values, type) {
  const index = new Map();
  for (const value of values.filter((candidate) => candidate.type === type)) {
    const id = broadcastContractId(value);
    if (index.has(id)) fail("duplicate_broadcast_contract");
    index.set(id, value);
  }
  return index;
}

function assertReferences(ids, index) {
  for (const id of ids || []) {
    if (!index.has(id)) fail("unknown_broadcast_reference");
  }
}

export function validateBroadcastAggregate(values, context = {}, now = Date.now()) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_BROADCAST_AGGREGATE_ITEMS) {
    fail("invalid_broadcast_aggregate");
  }
  const validated = values.map((value) => validateBroadcastContract(value, context, now));
  const programs = indexContracts(validated, "broadcast-program");
  if (programs.size !== 1) fail("invalid_broadcast_program_count");
  const program = [...programs.values()][0];

  for (const value of validated) {
    if (value.tenantId !== program.tenantId) fail("broadcast_tenant_id_mismatch");
    if (value.roomId !== undefined && value.roomId !== program.roomId) fail("broadcast_room_id_mismatch");
    if (value.programId !== undefined && value.programId !== program.programId) {
      fail("broadcast_program_id_mismatch");
    }
    if (value.programEpoch !== undefined && value.programEpoch !== program.programEpoch) {
      fail("broadcast_program_epoch_mismatch");
    }
  }

  const sources = indexContracts(validated, "program-source");
  const publications = indexContracts(validated, "publication");
  const renditions = indexContracts(validated, "rendition");
  const endpoints = indexContracts(validated, "delivery-endpoint");
  const capabilities = indexContracts(validated, "provider-capability");
  const consents = indexContracts(validated, "consent");
  const leases = indexContracts(validated, "lease");
  const grants = indexContracts(validated, "grant");
  const policies = indexContracts(validated, "viewer-policy");
  const captions = indexContracts(validated, "caption-track");

  assertReferences(program.sourceIds, sources);
  assertReferences(program.publicationIds, publications);
  assertReferences(program.endpointIds, endpoints);
  assertReferences(program.captionTrackIds, captions);
  if (program.viewerPolicyId !== undefined && !policies.has(program.viewerPolicyId)) {
    fail("unknown_broadcast_reference");
  }

  for (const source of sources.values()) {
    if (source.trustMode === "trusted-program") {
      const consent = consents.get(source.consentId);
      if (!consent || consent.status !== "active" || consent.expiresAt <= now
        || consent.grantorSubjectRef !== source.subjectRef
        || !consent.sourceIds.includes(source.sourceId)
        || !consent.actions.includes("decrypt-source")) {
        fail("invalid_broadcast_source_consent");
      }
    }
  }

  for (const publication of publications.values()) {
    assertReferences(publication.sourceIds, sources);
    if (publication.leaseId !== undefined && !leases.has(publication.leaseId)) {
      fail("unknown_broadcast_reference");
    }
    if (publication.capabilityId !== undefined && !capabilities.has(publication.capabilityId)) {
      fail("unknown_broadcast_reference");
    }
  }
  for (const rendition of renditions.values()) {
    if (!publications.has(rendition.publicationId)) fail("unknown_broadcast_reference");
  }
  for (const endpoint of endpoints.values()) {
    const capability = capabilities.get(endpoint.capabilityId);
    if (!publications.has(endpoint.publicationId) || !capability) fail("unknown_broadcast_reference");
    if (!capability.runtimeVerified || capability.status === "unavailable"
      || !capability.outputProtocols.includes(endpoint.protocol)) {
      fail("unsupported_broadcast_delivery_capability");
    }
    if (endpoint.visibility !== program.visibility) fail("broadcast_visibility_mismatch");
  }
  for (const caption of captions.values()) {
    if (!sources.has(caption.sourceId)) fail("unknown_broadcast_reference");
    if (caption.visibility !== program.visibility) fail("broadcast_visibility_mismatch");
  }
  for (const policy of policies.values()) {
    if (policy.visibility !== program.visibility) fail("broadcast_visibility_mismatch");
  }

  const activeLeaseRoles = new Set();
  for (const lease of leases.values()) {
    if (lease.status !== "active") continue;
    if (activeLeaseRoles.has(lease.role)) fail("duplicate_active_broadcast_writer");
    activeLeaseRoles.add(lease.role);
  }

  const entityIndexes = {
    program: programs,
    source: sources,
    publication: publications,
    rendition: renditions,
    endpoint: endpoints,
    consent: consents,
    lease: leases,
    grant: grants,
    "viewer-policy": policies,
    "caption-track": captions,
  };
  for (const event of validated.filter((value) => value.type === "event")) {
    if (!entityIndexes[event.entityKind].has(event.entityRef)) fail("unknown_broadcast_reference");
  }

  return Object.freeze([...validated]);
}
