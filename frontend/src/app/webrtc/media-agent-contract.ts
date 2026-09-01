const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PEER_ID = /^[a-f0-9]{16}$/;
const PUBLICATION_ID = /^[A-Za-z0-9_={}:-]{1,128}$/;
const REQUEST_ID = /^[a-f0-9]{32}$/;
const ROOM_ID = /^[a-z0-9][a-z0-9-]{5,47}$/;
const MEDIA_LAYERS = new Set(["audio", "single", "low", "medium", "high"] as const);
const MEDIA_RIDS = new Set(["", "q", "h", "f"] as const);

export type MediaAgentLayer = "audio" | "single" | "low" | "medium" | "high";

export interface MediaAgentCandidate {
  readonly id: string;
  readonly ownerPeerId: string;
  readonly creatorPreferred: boolean;
}

export interface MediaAgentRouteState {
  readonly version: 3;
  readonly type: "media-agent-state";
  readonly enabled: boolean;
  readonly membershipEpoch: number;
  readonly routeEpoch: number;
  readonly leaseExpiresAt: number;
  readonly primary: MediaAgentCandidate | null;
  readonly standbys: readonly MediaAgentCandidate[];
  readonly forwarderIds: readonly string[];
  readonly publisherAssignments: readonly Readonly<{ peerId: string; agentId: string }>[];
  readonly subscriberAssignments: readonly Readonly<{ peerId: string; agentId: string }>[];
  readonly federationLinks: readonly Readonly<{
    linkId: string;
    leftAgentId: string;
    rightAgentId: string;
    initiatorAgentId: string;
    readyAgentIds: readonly string[];
  }>[];
  readonly federationRoutes: readonly Readonly<{
    publisherPeerId: string;
    sourceAgentId: string;
    maximumHops: number;
    edges: readonly Readonly<{ linkId: string; fromAgentId: string; toAgentId: string }>[];
  }>[];
  readonly readiness: readonly Readonly<{ agentId: string; readyPeerIds: readonly string[] }>[];
}

export interface MediaAgentTakeoverRequest {
  readonly version: 1;
  readonly type: "media-agent-takeover-request";
  readonly requestId: string;
  readonly agentId: string;
  readonly expiresAt: number;
  readonly creatorPreferred: boolean;
}

export interface MediaAgentTrackState {
  readonly version: 2;
  readonly type: "media-agent-track-state";
  readonly agentId: string;
  readonly routeEpoch: number;
  readonly peerId: string;
  readonly publicationId: string;
  readonly source: "microphone" | "camera" | "screen" | "screen-audio";
  readonly layer: MediaAgentLayer;
  readonly rid: "" | "q" | "h" | "f";
  readonly active: boolean;
}

export interface MediaAgentSubscriptionState {
  readonly version: 2;
  readonly type: "media-agent-subscription-state";
  readonly agentId: string;
  readonly routeEpoch: number;
  readonly publicationId: string;
  readonly subscriberPeerId: string;
  readonly selectedLayer: MediaAgentLayer;
  readonly revision: number;
  readonly ready: boolean;
}

export type MediaAgentSignal = Readonly<{
  version: 1;
  type: "media-agent-signal";
  agentId: string;
  roomId: string;
  routeEpoch: number;
} & ({ description: RTCSessionDescriptionInit } | { candidate: RTCIceCandidateInit | null })>;

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function candidate(raw: unknown): MediaAgentCandidate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!exact(value, ["id", "ownerPeerId", "creatorPreferred"])
    || !AGENT_ID.test(String(value["id"] || "")) || !PEER_ID.test(String(value["ownerPeerId"] || ""))
    || typeof value["creatorPreferred"] !== "boolean") return null;
  return Object.freeze(value as unknown as MediaAgentCandidate);
}

export function validateMediaAgentRouteState(
  raw: unknown,
  members: ReadonlySet<string>,
  membershipEpoch: number,
  lastRouteEpoch: number,
  now = Date.now(),
  maximumLeaseMs = 120_000,
): MediaAgentRouteState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!exact(value, [
    "version", "type", "enabled", "membershipEpoch", "routeEpoch", "leaseExpiresAt",
    "primary", "standbys", "forwarderIds", "publisherAssignments", "subscriberAssignments",
    "federationLinks", "federationRoutes", "readiness",
  ]) || value["version"] !== 3 || value["type"] !== "media-agent-state"
    || typeof value["enabled"] !== "boolean") return null;
  const stateMembershipEpoch = Number(value["membershipEpoch"]);
  const routeEpoch = Number(value["routeEpoch"]);
  const leaseExpiresAt = Number(value["leaseExpiresAt"]);
  if (stateMembershipEpoch !== membershipEpoch || !Number.isSafeInteger(routeEpoch) || routeEpoch < 1
    || routeEpoch < lastRouteEpoch || !Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt <= now
    || leaseExpiresAt > now + maximumLeaseMs) return null;
  const primary = value["primary"] === null ? null : candidate(value["primary"]);
  if (value["primary"] !== null && !primary) return null;
  if (!Array.isArray(value["standbys"]) || value["standbys"].length > 2) return null;
  const standbys = value["standbys"].map(candidate);
  if (standbys.some((entry) => !entry)) return null;
  const agents = [primary, ...standbys].filter(Boolean) as MediaAgentCandidate[];
  if (new Set(agents.map(({ id }) => id)).size !== agents.length
    || agents.some(({ ownerPeerId }) => !members.has(ownerPeerId))) return null;
  if (!Array.isArray(value["forwarderIds"]) || value["forwarderIds"].length > 3
    || value["forwarderIds"].some((id) => typeof id !== "string" || !agents.some((agent) => agent.id === id))
    || new Set(value["forwarderIds"]).size !== value["forwarderIds"].length
    || (primary && value["forwarderIds"][0] !== primary.id)) return null;
  const forwarderIds = value["forwarderIds"] as string[];
  if (!Array.isArray(value["publisherAssignments"]) || value["publisherAssignments"].length > 20) return null;
  const publisherAssignments: Array<{ peerId: string; agentId: string }> = [];
  for (const rawAssignment of value["publisherAssignments"]) {
    if (!rawAssignment || typeof rawAssignment !== "object" || Array.isArray(rawAssignment)) return null;
    const assignment = rawAssignment as Record<string, unknown>;
    if (!exact(assignment, ["peerId", "agentId"]) || !members.has(String(assignment["peerId"] || ""))
      || !forwarderIds.includes(String(assignment["agentId"] || ""))) return null;
    publisherAssignments.push({ peerId: String(assignment["peerId"]), agentId: String(assignment["agentId"]) });
  }
  if (new Set(publisherAssignments.map(({ peerId }) => peerId)).size !== publisherAssignments.length
    || (primary && publisherAssignments.length !== members.size)
    || (!primary && (forwarderIds.length > 0 || publisherAssignments.length > 0))) return null;
  if (!Array.isArray(value["subscriberAssignments"]) || value["subscriberAssignments"].length > 20) return null;
  const subscriberAssignments: Array<{ peerId: string; agentId: string }> = [];
  for (const rawAssignment of value["subscriberAssignments"]) {
    if (!rawAssignment || typeof rawAssignment !== "object" || Array.isArray(rawAssignment)) return null;
    const assignment = rawAssignment as Record<string, unknown>;
    if (!exact(assignment, ["peerId", "agentId"]) || !members.has(String(assignment["peerId"] || ""))
      || !forwarderIds.includes(String(assignment["agentId"] || ""))) return null;
    subscriberAssignments.push({
      peerId: String(assignment["peerId"]),
      agentId: String(assignment["agentId"]),
    });
  }
  if (new Set(subscriberAssignments.map(({ peerId }) => peerId)).size !== subscriberAssignments.length
    || (primary && subscriberAssignments.length !== members.size)
    || (!primary && subscriberAssignments.length > 0)) return null;
  if (!Array.isArray(value["federationLinks"]) || value["federationLinks"].length > 2) return null;
  const linkIds = new Set<string>();
  const linksById = new Map<string, Readonly<{ leftAgentId: string; rightAgentId: string }>>();
  const federationLinks: MediaAgentRouteState["federationLinks"][number][] = [];
  for (const rawLink of value["federationLinks"]) {
    if (!rawLink || typeof rawLink !== "object" || Array.isArray(rawLink)) return null;
    const link = rawLink as Record<string, unknown>;
    if (!exact(link, ["linkId", "leftAgentId", "rightAgentId", "initiatorAgentId", "readyAgentIds"])
      || !/^[A-Za-z0-9_-]{22}$/.test(String(link["linkId"] || ""))
      || !forwarderIds.includes(String(link["leftAgentId"] || ""))
      || !forwarderIds.includes(String(link["rightAgentId"] || ""))
      || link["leftAgentId"] === link["rightAgentId"]
      || !new Set([link["leftAgentId"], link["rightAgentId"]]).has(link["initiatorAgentId"])
      || !Array.isArray(link["readyAgentIds"]) || link["readyAgentIds"].length > 2
      || link["readyAgentIds"].some((agentId) => !new Set([
        link["leftAgentId"], link["rightAgentId"],
      ]).has(agentId)) || new Set(link["readyAgentIds"]).size !== link["readyAgentIds"].length
      || linkIds.has(String(link["linkId"]))) return null;
    linkIds.add(String(link["linkId"]));
    linksById.set(String(link["linkId"]), Object.freeze({
      leftAgentId: String(link["leftAgentId"]),
      rightAgentId: String(link["rightAgentId"]),
    }));
    federationLinks.push(Object.freeze({
      linkId: String(link["linkId"]),
      leftAgentId: String(link["leftAgentId"]),
      rightAgentId: String(link["rightAgentId"]),
      initiatorAgentId: String(link["initiatorAgentId"]),
      readyAgentIds: Object.freeze([...(link["readyAgentIds"] as string[])]),
    }));
  }
  if (!Array.isArray(value["federationRoutes"]) || value["federationRoutes"].length > 20) return null;
  const federationRoutes: MediaAgentRouteState["federationRoutes"][number][] = [];
  const routedPublishers = new Set<string>();
  for (const rawRoute of value["federationRoutes"]) {
    if (!rawRoute || typeof rawRoute !== "object" || Array.isArray(rawRoute)) return null;
    const route = rawRoute as Record<string, unknown>;
    const publisherPeerId = String(route["publisherPeerId"] || "");
    const sourceAgentId = String(route["sourceAgentId"] || "");
    const maximumHops = Number(route["maximumHops"]);
    if (!exact(route, ["publisherPeerId", "sourceAgentId", "maximumHops", "edges"])
      || !members.has(publisherPeerId)
      || publisherAssignments.find(({ peerId }) => peerId === publisherPeerId)?.agentId !== sourceAgentId
      || maximumHops < 1 || maximumHops > 2 || !Number.isSafeInteger(maximumHops)
      || !Array.isArray(route["edges"]) || route["edges"].length > 2
      || routedPublishers.has(publisherPeerId)) return null;
    const visited = new Set([sourceAgentId]);
    const depth = new Map([[sourceAgentId, 0]]);
    const edges: Array<{ linkId: string; fromAgentId: string; toAgentId: string }> = [];
    for (const rawEdge of route["edges"]) {
      if (!rawEdge || typeof rawEdge !== "object" || Array.isArray(rawEdge)) return null;
      const edge = rawEdge as Record<string, unknown>;
      const linkId = String(edge["linkId"] || "");
      const fromAgentId = String(edge["fromAgentId"] || "");
      const toAgentId = String(edge["toAgentId"] || "");
      const link = linksById.get(linkId);
      const edgeDepth = (depth.get(fromAgentId) ?? maximumHops) + 1;
      if (!exact(edge, ["linkId", "fromAgentId", "toAgentId"])
        || !link || !visited.has(fromAgentId) || visited.has(toAgentId)
        || fromAgentId === toAgentId || edgeDepth > maximumHops
        || !((link.leftAgentId === fromAgentId && link.rightAgentId === toAgentId)
          || (link.rightAgentId === fromAgentId && link.leftAgentId === toAgentId))) return null;
      visited.add(toAgentId);
      depth.set(toAgentId, edgeDepth);
      edges.push({ linkId, fromAgentId, toAgentId });
    }
    routedPublishers.add(publisherPeerId);
    federationRoutes.push(Object.freeze({
      publisherPeerId,
      sourceAgentId,
      maximumHops,
      edges: Object.freeze(edges.map((edge) => Object.freeze(edge))),
    }));
  }
  if (!Array.isArray(value["readiness"]) || value["readiness"].length !== forwarderIds.length) return null;
  const readiness: Array<{ agentId: string; readyPeerIds: readonly string[] }> = [];
  for (const rawReadiness of value["readiness"]) {
    if (!rawReadiness || typeof rawReadiness !== "object" || Array.isArray(rawReadiness)) return null;
    const entry = rawReadiness as Record<string, unknown>;
    if (!exact(entry, ["agentId", "readyPeerIds"]) || !forwarderIds.includes(String(entry["agentId"] || ""))
      || !Array.isArray(entry["readyPeerIds"]) || entry["readyPeerIds"].length > 20
      || entry["readyPeerIds"].some((peerId) => typeof peerId !== "string" || !members.has(peerId))
      || new Set(entry["readyPeerIds"]).size !== entry["readyPeerIds"].length) return null;
    readiness.push({
      agentId: String(entry["agentId"]),
      readyPeerIds: Object.freeze([...(entry["readyPeerIds"] as string[])]),
    });
  }
  if (new Set(readiness.map(({ agentId }) => agentId)).size !== readiness.length) return null;
  return Object.freeze({
    version: 3,
    type: "media-agent-state",
    enabled: value["enabled"],
    membershipEpoch: stateMembershipEpoch,
    routeEpoch,
    leaseExpiresAt,
    primary,
    standbys: Object.freeze(standbys as MediaAgentCandidate[]),
    forwarderIds: Object.freeze([...forwarderIds]),
    publisherAssignments: Object.freeze(publisherAssignments.map((entry) => Object.freeze(entry))),
    subscriberAssignments: Object.freeze(subscriberAssignments.map((entry) => Object.freeze(entry))),
    federationLinks: Object.freeze(federationLinks),
    federationRoutes: Object.freeze(federationRoutes),
    readiness: Object.freeze(readiness.map((entry) => Object.freeze(entry))),
  });
}

export function validateMediaAgentTakeoverRequest(raw: unknown, now = Date.now()): MediaAgentTakeoverRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const expiresAt = Number(value["expiresAt"]);
  if (!exact(value, ["version", "type", "requestId", "agentId", "expiresAt", "creatorPreferred"])
    || value["version"] !== 1 || value["type"] !== "media-agent-takeover-request"
    || !REQUEST_ID.test(String(value["requestId"] || "")) || !AGENT_ID.test(String(value["agentId"] || ""))
    || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 60_000
    || typeof value["creatorPreferred"] !== "boolean") return null;
  return Object.freeze(value as unknown as MediaAgentTakeoverRequest);
}

export function validateMediaAgentTrackState(raw: unknown): MediaAgentTrackState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const sources = new Set(["microphone", "camera", "screen", "screen-audio"]);
  if (!exact(value, [
    "version", "type", "agentId", "routeEpoch", "peerId", "publicationId", "source", "layer", "rid", "active",
  ]) || value["version"] !== 2 || value["type"] !== "media-agent-track-state"
    || !AGENT_ID.test(String(value["agentId"] || "")) || !PEER_ID.test(String(value["peerId"] || ""))
    || !PUBLICATION_ID.test(String(value["publicationId"] || "")) || !sources.has(String(value["source"] || ""))
    || !MEDIA_LAYERS.has(value["layer"] as MediaAgentLayer)
    || !MEDIA_RIDS.has(value["rid"] as "" | "q" | "h" | "f")
    || !Number.isSafeInteger(value["routeEpoch"]) || Number(value["routeEpoch"]) < 1
    || typeof value["active"] !== "boolean") return null;
  return Object.freeze({
    version: 2,
    type: "media-agent-track-state",
    agentId: String(value["agentId"]),
    routeEpoch: Number(value["routeEpoch"]),
    peerId: String(value["peerId"]),
    publicationId: String(value["publicationId"]),
    source: value["source"] as MediaAgentTrackState["source"],
    layer: value["layer"] as MediaAgentLayer,
    rid: value["rid"] as MediaAgentTrackState["rid"],
    active: value["active"],
  });
}

export function validateMediaAgentSubscriptionState(raw: unknown): MediaAgentSubscriptionState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!exact(value, [
    "version", "type", "agentId", "routeEpoch", "publicationId", "subscriberPeerId", "selectedLayer",
    "revision", "ready",
  ]) || value["version"] !== 2 || value["type"] !== "media-agent-subscription-state"
    || !AGENT_ID.test(String(value["agentId"] || ""))
    || !PUBLICATION_ID.test(String(value["publicationId"] || ""))
    || !PEER_ID.test(String(value["subscriberPeerId"] || ""))
    || !MEDIA_LAYERS.has(value["selectedLayer"] as MediaAgentLayer)
    || !Number.isSafeInteger(value["revision"]) || Number(value["revision"]) < 1
    || !Number.isSafeInteger(value["routeEpoch"]) || Number(value["routeEpoch"]) < 1
    || typeof value["ready"] !== "boolean") return null;
  return Object.freeze({
    version: 2,
    type: "media-agent-subscription-state",
    agentId: String(value["agentId"]),
    routeEpoch: Number(value["routeEpoch"]),
    publicationId: String(value["publicationId"]),
    subscriberPeerId: String(value["subscriberPeerId"]),
    selectedLayer: value["selectedLayer"] as MediaAgentLayer,
    revision: Number(value["revision"]),
    ready: value["ready"],
  });
}

export function validateMediaAgentSignal(raw: unknown): MediaAgentSignal | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const hasDescription = Object.hasOwn(value, "description");
  const hasCandidate = Object.hasOwn(value, "candidate");
  const payloadField = hasDescription ? "description" : "candidate";
  if (hasDescription === hasCandidate || !exact(value, [
    "version", "type", "agentId", "roomId", "routeEpoch", payloadField,
  ]) || value["version"] !== 1 || value["type"] !== "media-agent-signal"
    || !AGENT_ID.test(String(value["agentId"] || "")) || !ROOM_ID.test(String(value["roomId"] || ""))
    || !Number.isSafeInteger(value["routeEpoch"]) || Number(value["routeEpoch"]) < 1) return null;
  const base = {
    version: 1 as const,
    type: "media-agent-signal" as const,
    agentId: String(value["agentId"]),
    roomId: String(value["roomId"]),
    routeEpoch: Number(value["routeEpoch"]),
  };
  if (hasDescription) {
    const rawDescription = value["description"];
    if (!rawDescription || typeof rawDescription !== "object" || Array.isArray(rawDescription)) return null;
    const description = rawDescription as Record<string, unknown>;
    if (!exact(description, ["type", "sdp"]) || !new Set(["offer", "answer"]).has(String(description["type"] || ""))
      || typeof description["sdp"] !== "string" || description["sdp"].length > 80_000) return null;
    return Object.freeze({ ...base, description: Object.freeze({
      type: description["type"] as RTCSdpType,
      sdp: description["sdp"],
    }) });
  }
  if (value["candidate"] === null) return Object.freeze({ ...base, candidate: null });
  const rawCandidate = value["candidate"];
  if (!rawCandidate || typeof rawCandidate !== "object" || Array.isArray(rawCandidate)) return null;
  const candidate = rawCandidate as Record<string, unknown>;
  const allowed = new Set(["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"]);
  if (Object.keys(candidate).some((field) => !allowed.has(field))
    || typeof candidate["candidate"] !== "string" || candidate["candidate"].length > 4_096
    || (Object.hasOwn(candidate, "sdpMid") && candidate["sdpMid"] !== null && typeof candidate["sdpMid"] !== "string")
    || (Object.hasOwn(candidate, "sdpMLineIndex") && candidate["sdpMLineIndex"] !== null
      && !Number.isSafeInteger(candidate["sdpMLineIndex"]))
    || (Object.hasOwn(candidate, "usernameFragment") && candidate["usernameFragment"] !== null
      && typeof candidate["usernameFragment"] !== "string")) return null;
  return Object.freeze({ ...base, candidate: Object.freeze({
    candidate: candidate["candidate"],
    ...(Object.hasOwn(candidate, "sdpMid") ? { sdpMid: candidate["sdpMid"] as string | null } : {}),
    ...(Object.hasOwn(candidate, "sdpMLineIndex")
      ? { sdpMLineIndex: candidate["sdpMLineIndex"] as number | null } : {}),
    ...(Object.hasOwn(candidate, "usernameFragment")
      ? { usernameFragment: candidate["usernameFragment"] as string | null } : {}),
  }) });
}
