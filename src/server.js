import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

import { loadConfig } from "./config.js";
import { DeviceProofError, DeviceProofVerifier } from "./device-proof.js";
import { parseBrowserMediaAgentMessage, parseMediaAgentMessage } from "./media-agent-protocol.js";
import { MediaAgentRegistry } from "./media-agent-registry.js";
import { buildRoomTopology } from "./media-topology.js";
import { RelayHealthTracker } from "./relay-health.js";
import {
  normalizeRoomTitle,
  normalizeRoomVisibility,
  RoomDirectory,
  RoomDirectoryError,
} from "./room-directory.js";
import { AuthenticationError, bearerToken, createOidcVerifier } from "./oidc-verifier.js";
import { PairWorkspaceError, PairWorkspaceStore } from "./pair-workspace-store.js";
import {
  encodeServerMessage,
  normalizeDisplayName,
  normalizeRoomId,
  parseClientMessage,
  ProtocolError,
} from "./protocol.js";
import { RoomAdmissionError, RoomFullError, RoomRegistry } from "./room-registry.js";
import { SessionTicketError, SessionTicketStore } from "./session-tickets.js";
import { createEdgeTurnCredentials, createTurnCredentials } from "./turn-credentials.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(MODULE_DIR, "../dist/browser");
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);
const MAX_HTTP_BODY_BYTES = 16 * 1024;
const ROOM_REQUEST_FIELDS = new Set(["mode", "persistent", "title", "visibility"]);
const ROOM_UPDATE_FIELDS = new Set(["title", "visibility"]);
const SESSION_REQUEST_FIELDS = new Set(["roomId", "displayName", "mode", "deviceProof", "workspaceInvite"]);
const EVENT_REQUEST_FIELDS = new Set(["eventId", "correlationId", "kind", "payload"]);
const CURSOR_REQUEST_FIELDS = new Set(["sequence"]);
const PRESENCE_REQUEST_FIELDS = new Set(["state", "documentId", "line", "column", "leaseId", "epoch", "ttlMs"]);
const ROLE_REQUEST_FIELDS = new Set(["principal", "role", "expectedRevision"]);

function sendJson(response, statusCode, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(payload);
}

function securityHeaders(config) {
  const connectSources = ["'self'", "ws:", "wss:"];
  if (config.oidcIssuer) connectSources.push(new URL(config.oidcIssuer).origin);
  return {
    "content-security-policy": [
      "default-src 'self'",
      `connect-src ${connectSources.join(" ")}`,
      "img-src 'self' data:",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "),
    "permissions-policy": "camera=(self), microphone=(self), display-capture=(self)",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function requestOriginAllowed(request, config) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (config.publicOrigin) return origin === config.publicOrigin;
  const expectedProtocols = request.socket.encrypted ? ["https:"] : ["http:", "https:"];
  try {
    const parsed = new URL(origin);
    return expectedProtocols.includes(parsed.protocol) && parsed.host === request.headers.host;
  } catch {
    return false;
  }
}

function safeSend(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(encodeServerMessage(message));
}

function publicRuntimeConfig(config) {
  return {
    iceServers: [
      ...config.stunUrls.map((urls) => ({ urls })),
      ...config.turnServers,
    ],
    maxRoomParticipants: config.maxRoomParticipants,
    auth: {
      mode: config.authMode,
      issuer: config.oidcIssuer,
      clientId: config.oidcClientId,
      audience: config.oidcAudience,
    },
    pairParticipants: 2,
    turnConfigured: config.turnUrls.length > 0,
    edgeRelayConfigured: config.edgeTurnServers.length > 0,
    mediaE2ee: {
      mode: config.mediaE2eeMode,
      cipherSuite: "AES_128_GCM_SHA256_128",
    },
    mediaAgents: {
      configured: config.mediaAgents.length > 0,
      leaseMs: config.mediaAgentLeaseMs,
      maxStandbys: config.mediaAgentMaxStandbys,
      shardMinParticipants: config.mediaAgentShardMinParticipants,
    },
    optimization: {
      activeSpeakerLimit: config.activeSpeakerLimit,
      peerRelayEnabled: config.peerMediaRelayEnabled,
      peerRelayMinParticipants: config.peerMediaRelayMinParticipants,
      peerRelayMaxChildren: config.peerMediaRelayMaxChildren,
      peerRelayMaxHops: config.peerMediaRelayMaxHops,
      routeLeaseMs: config.peerRouteLeaseMs,
      dataOverlayEnabled: config.peerDataOverlayEnabled,
    },
    pairWorkspaceEnabled: config.pairWorkspaceEnabled,
  };
}

async function serveStatic(request, response, pathname, config, publicDir) {
  let requestedPath;
  try {
    requestedPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    sendJson(response, 400, { error: "invalid_path" });
    return;
  }
  let absolutePath = path.resolve(publicDir, `.${requestedPath}`);
  if (absolutePath !== publicDir && !absolutePath.startsWith(`${publicDir}${path.sep}`)) {
    sendJson(response, 404, { error: "not_found" }, securityHeaders(config));
    return;
  }
  try {
    let content;
    try {
      content = await fs.readFile(absolutePath);
    } catch (error) {
      if ((error.code === "ENOENT" || error.code === "EISDIR") && !path.extname(requestedPath)) {
        absolutePath = path.join(publicDir, "index.html");
        content = await fs.readFile(absolutePath);
        requestedPath = "/index.html";
      } else {
        throw error;
      }
    }
    response.writeHead(200, {
      "content-type": MIME_TYPES.get(path.extname(absolutePath)) || "application/octet-stream",
      "content-length": content.length,
      "cache-control": requestedPath === "/index.html" ? "no-cache" : "public, max-age=300",
      ...securityHeaders(config),
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      sendJson(response, 404, { error: "not_found" }, securityHeaders(config));
      return;
    }
    throw error;
  }
}

function requestOrigin(request, config) {
  return request.headers.origin
    || config.publicOrigin
    || `${request.socket.encrypted ? "https" : "http"}://${request.headers.host}`;
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_HTTP_BODY_BYTES) throw new ProtocolError("request_too_large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProtocolError("invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("invalid_request");
  }
  return value;
}

function normalizeMode(value) {
  const mode = String(value || "room");
  if (!new Set(["room", "pair"]).has(mode)) throw new ProtocolError("invalid_room_mode");
  return mode;
}

function assertAllowedKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ProtocolError("unknown_request_field");
  }
}

async function authenticateRequest(request, config, oidcVerifier) {
  const token = bearerToken(request.headers.authorization);
  if (!token) {
    if (config.authMode === "required") throw new AuthenticationError("authentication_required");
    return null;
  }
  if (config.authMode === "disabled") throw new AuthenticationError("authentication_disabled");
  return oidcVerifier.verify(token);
}

async function authenticateOptionalRequest(request, config, oidcVerifier) {
  const token = bearerToken(request.headers.authorization);
  if (!token) return null;
  if (config.authMode === "disabled") throw new AuthenticationError("authentication_disabled");
  return oidcVerifier.verify(token);
}

function principalFor(identity) {
  return identity ? `${identity.issuer}|${identity.subject}` : "";
}

function errorStatus(error) {
  if (error instanceof RoomDirectoryError) return error.status;
  if (error instanceof PairWorkspaceError) return error.status;
  if (error instanceof AuthenticationError) return 401;
  if (error instanceof ProtocolError || error instanceof DeviceProofError) return 400;
  return 500;
}

function createHttpHandler(config, registry, services) {
  const { oidcVerifier, deviceProofVerifier, ticketStore, workspaceStore, directory, publicDir } = services;
  return async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, {
          status: "ok",
          rooms: registry.roomCount,
          participants: registry.participantCount,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/config") {
        sendJson(response, 200, publicRuntimeConfig(config), securityHeaders(config));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/rooms") {
        const identity = await authenticateOptionalRequest(request, config, oidcVerifier);
        directory.prune(Date.now(), (roomId) => registry.members(roomId).length > 0);
        sendJson(response, 200, directory.list({
          principal: principalFor(identity),
          participantCount: (roomId) => registry.members(roomId).length,
        }), securityHeaders(config));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/rooms") {
        if (!requestOriginAllowed(request, config)) throw new ProtocolError("origin_denied");
        const identity = await authenticateRequest(request, config, oidcVerifier);
        const input = await readJsonBody(request);
        assertAllowedKeys(input, ROOM_REQUEST_FIELDS);
        const mode = normalizeMode(input.mode);
        if (input.persistent !== undefined && typeof input.persistent !== "boolean") {
          throw new ProtocolError("invalid_persistent_workspace");
        }
        const persistent = input.persistent === true;
        if (persistent && mode !== "pair") throw new ProtocolError("persistent_workspace_requires_pair");
        if (persistent && (!config.pairWorkspaceEnabled || !workspaceStore)) {
          throw new PairWorkspaceError("workspace_disabled", 404);
        }
        if (persistent && !identity) throw new PairWorkspaceError("authentication_required", 401);
        const roomId = `${mode}-${crypto.randomBytes(9).toString("hex")}`;
        const origin = requestOrigin(request, config);
        let roomMetadata = null;
        if (mode === "room") {
          const title = normalizeRoomTitle(input.title, `Raum ${roomId.slice(-6)}`);
          const visibility = normalizeRoomVisibility(input.visibility);
          if (visibility === "public" && !identity) {
            throw new AuthenticationError("authentication_required");
          }
          if (identity) {
            roomMetadata = directory.create({
              roomId,
              title,
              visibility,
              ownerPrincipal: principalFor(identity),
            });
          } else {
            roomMetadata = { title, visibility, owned: false };
          }
        } else if (input.visibility !== undefined) {
          throw new ProtocolError("room_visibility_requires_room");
        }
        const workspace = persistent ? workspaceStore.create({
          roomId,
          title: input.title,
          ownerPrincipal: principalFor(identity),
        }) : null;
        sendJson(response, 201, {
          roomId,
          mode,
          persistent,
          ...(roomMetadata ? {
            title: roomMetadata.title,
            visibility: roomMetadata.visibility,
            owned: roomMetadata.owned,
          } : {}),
          ...(workspace ? { workspaceId: workspace.workspaceId, role: workspace.role } : {}),
          inviteUrl: `${origin}/?room=${encodeURIComponent(roomId)}&mode=${mode}`
            + (workspace ? `&workspaceInvite=${encodeURIComponent(workspace.inviteToken)}` : ""),
        }, securityHeaders(config));
        return;
      }
      const roomMatch = url.pathname.match(/^\/api\/rooms\/(room-[a-f0-9]{18})$/);
      if (roomMatch && request.method === "PATCH") {
        if (!requestOriginAllowed(request, config)) throw new ProtocolError("origin_denied");
        const identity = await authenticateRequest(request, config, oidcVerifier);
        if (!identity) throw new AuthenticationError("authentication_required");
        const input = await readJsonBody(request);
        assertAllowedKeys(input, ROOM_UPDATE_FIELDS);
        directory.update(roomMatch[1], principalFor(identity), input);
        const room = directory.list({
          principal: principalFor(identity),
          participantCount: (roomId) => registry.members(roomId).length,
        }).ownRooms.find((entry) => entry.roomId === roomMatch[1]);
        sendJson(response, 200, { room }, securityHeaders(config));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/sessions") {
        if (!requestOriginAllowed(request, config)) throw new ProtocolError("origin_denied");
        const input = await readJsonBody(request);
        assertAllowedKeys(input, SESSION_REQUEST_FIELDS);
        const roomId = normalizeRoomId(input.roomId);
        const mode = normalizeMode(input.mode);
        const requestedName = normalizeDisplayName(input.displayName);
        const identity = await authenticateRequest(request, config, oidcVerifier);
        const device = deviceProofVerifier.verify(input.deviceProof, {
          roomId,
          mode,
          displayName: requestedName,
        });
        const principal = identity
          ? `${identity.issuer}|${identity.subject}`
          : `anonymous:${device.fingerprint}`;
        const authorizedName = identity ? normalizeDisplayName(identity.displayName) : requestedName;
        const workspace = workspaceStore?.admit(
          roomId,
          identity ? principal : "",
          String(input.workspaceInvite || ""),
        ) || null;
        if (workspace && mode !== "pair") throw new PairWorkspaceError("workspace_pair_mode_required", 409);
        const origin = requestOrigin(request, config);
        const issued = ticketStore.issue({
          roomId,
          mode,
          name: authorizedName,
          principal,
          authenticated: Boolean(identity),
          deviceFingerprint: device.fingerprint,
          origin,
          workspaceId: workspace?.workspaceId || "",
          workspaceRole: workspace?.role || "",
        });
        const directIceServers = config.stunUrls.map((urls) => ({ urls }));
        const peerRelayIceServers = createEdgeTurnCredentials(config, principal);
        const infrastructureRelayIceServers = [
          ...config.turnServers,
          ...createTurnCredentials(config, principal),
        ];
        sendJson(response, 201, {
          ticket: issued.ticket,
          expiresAt: issued.expiresAt,
          signalingPath: `/signal?ticket=${encodeURIComponent(issued.ticket)}`,
          identity: identity ? { authenticated: true, displayName: identity.displayName } : { authenticated: false },
          workspace,
          icePolicy: {
            version: 1,
            directIceServers,
            peerRelayIceServers,
            infrastructureRelayIceServers,
            peerRelayAfterMs: config.peerEdgeFallbackMs,
            infrastructureRelayAfterMs: config.infrastructureTurnFallbackMs,
          },
          iceServers: [
            ...directIceServers,
            ...peerRelayIceServers,
            ...infrastructureRelayIceServers,
          ],
        }, securityHeaders(config));
        return;
      }
      if (url.pathname === "/api/workspaces" && request.method === "GET") {
        if (!config.pairWorkspaceEnabled || !workspaceStore) throw new PairWorkspaceError("workspace_disabled", 404);
        const identity = await authenticateRequest(request, config, oidcVerifier);
        if (!identity) throw new PairWorkspaceError("authentication_required", 401);
        sendJson(response, 200, {
          workspaces: workspaceStore.list(`${identity.issuer}|${identity.subject}`),
        }, securityHeaders(config));
        return;
      }
      const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/([0-9a-f-]{36})(?:\/(events|cursor|presence|roles))?$/);
      if (workspaceMatch) {
        if (!config.pairWorkspaceEnabled || !workspaceStore) throw new PairWorkspaceError("workspace_disabled", 404);
        if (!requestOriginAllowed(request, config)) throw new ProtocolError("origin_denied");
        const identity = await authenticateRequest(request, config, oidcVerifier);
        if (!identity) throw new PairWorkspaceError("authentication_required", 401);
        const principal = `${identity.issuer}|${identity.subject}`;
        const [, workspaceId, resource] = workspaceMatch;
        if (!resource && request.method === "GET") {
          sendJson(response, 200, workspaceStore.get(workspaceId, principal), securityHeaders(config));
          return;
        }
        if (resource === "events" && request.method === "GET") {
          const after = Number(url.searchParams.get("after") || 0);
          const limit = Number(url.searchParams.get("limit") || 100);
          sendJson(response, 200, { events: workspaceStore.timeline(workspaceId, principal, { after, limit }) }, securityHeaders(config));
          return;
        }
        if (resource === "events" && request.method === "POST") {
          const input = await readJsonBody(request);
          assertAllowedKeys(input, EVENT_REQUEST_FIELDS);
          sendJson(response, 201, workspaceStore.appendEvent(workspaceId, principal, input), securityHeaders(config));
          return;
        }
        if (resource === "cursor" && request.method === "PUT") {
          const input = await readJsonBody(request);
          assertAllowedKeys(input, CURSOR_REQUEST_FIELDS);
          sendJson(response, 200, workspaceStore.setCursor(workspaceId, principal, input.sequence), securityHeaders(config));
          return;
        }
        if (resource === "presence" && request.method === "PUT") {
          const input = await readJsonBody(request);
          assertAllowedKeys(input, PRESENCE_REQUEST_FIELDS);
          sendJson(response, 200, workspaceStore.setPresence(workspaceId, principal, input), securityHeaders(config));
          return;
        }
        if (resource === "roles" && request.method === "POST") {
          const input = await readJsonBody(request);
          assertAllowedKeys(input, ROLE_REQUEST_FIELDS);
          sendJson(response, 200, workspaceStore.setRole(
            workspaceId, principal, input.principal, input.role, input.expectedRevision,
          ), securityHeaders(config));
          return;
        }
        sendJson(response, 405, { error: "method_not_allowed" }, securityHeaders(config));
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "method_not_allowed" }, {
          allow: "GET, HEAD, POST, PATCH",
          ...securityHeaders(config),
        });
        return;
      }
      await serveStatic(request, response, url.pathname, config, publicDir);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 500) console.error("HTTP request failed", error);
      if (!response.headersSent) sendJson(response, status, {
        error: status === 500 ? "internal_error" : error.code,
      }, securityHeaders(config));
      else response.destroy();
    }
  };
}

function rejectUpgrade(socket, statusCode, message) {
  const body = JSON.stringify({ error: message });
  const statusText = new Map([[400, "Bad Request"], [401, "Unauthorized"], [403, "Forbidden"]]).get(statusCode) || "Error";
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
    "Content-Type: application/json\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "Connection: close\r\n\r\n" +
    body,
  );
}

function configureSignaling(server, config, registry, ticketStore, directory, mediaAgents) {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024 });
  const mediaAgentWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024 });
  const roomEpochs = new Map();
  const mediaAgentTracks = new Map();
  const mediaAgentTrackRouteEpochs = new Map();
  const relayHealth = new RelayHealthTracker({
    windowMs: config.peerRelayHealthWindowMs,
    cooldownMs: config.peerRelayHealthCooldownMs,
  });

  const iceServersForAgent = (agentId) => [
    ...config.stunUrls.map((urls) => ({ urls })),
    ...createEdgeTurnCredentials(config, `media-agent:${agentId}`),
    ...config.turnServers,
    ...createTurnCredentials(config, `media-agent:${agentId}`),
  ];

  const syncAgents = () => {
    for (const agentId of mediaAgents.connectedAgentIds()) {
      safeSend(mediaAgents.socketForAgent(agentId), {
        version: 1,
        type: "agent-sync",
        leases: mediaAgents.roomLeases(
          agentId,
          (roomId) => registry.members(roomId),
          iceServersForAgent,
        ),
      });
    }
  };

  const sendMediaAgentAvailability = (member) => safeSend(member.socket, {
    version: 1,
    type: "media-agent-availability",
    agents: mediaAgents.configuredForPrincipal(member.principal),
  });

  const broadcastPrincipalMediaAgentAvailability = (principal) => {
    for (const roomId of roomEpochs.keys()) {
      for (const member of registry.members(roomId)) {
        if (member.principal === principal) sendMediaAgentAvailability(member);
      }
    }
  };

  const broadcastMediaAgentState = (roomId) => {
    const members = registry.members(roomId);
    if (members.length === 0) {
      for (const key of mediaAgentTracks.keys()) {
        if (key.startsWith(`${roomId}\0`)) mediaAgentTracks.delete(key);
      }
      mediaAgentTrackRouteEpochs.delete(roomId);
      mediaAgents.removeRoom(roomId);
      syncAgents();
      return;
    }
    const membershipEpoch = roomEpochs.get(roomId)?.membership || 1;
    const state = mediaAgents.reconcile(roomId, members, membershipEpoch);
    if (mediaAgentTrackRouteEpochs.get(roomId) !== state.routeEpoch) {
      for (const key of mediaAgentTracks.keys()) {
        if (key.startsWith(`${roomId}\0`)) mediaAgentTracks.delete(key);
      }
      mediaAgentTrackRouteEpochs.set(roomId, state.routeEpoch);
    }
    for (const member of members) safeSend(member.socket, state);
    const takeover = mediaAgents.takeoverRequest(roomId);
    if (takeover) {
      const recipient = members.find((member) => member.id === takeover.peerId);
      if (recipient) safeSend(recipient.socket, { ...takeover, peerId: undefined });
    }
    syncAgents();
  };

  const broadcastTopology = (roomId, membershipChanged = false) => {
    const members = registry.members(roomId);
    if (members.length === 0) {
      roomEpochs.delete(roomId);
      relayHealth.removeRoom(roomId);
      broadcastMediaAgentState(roomId);
      return;
    }
    const epochs = roomEpochs.get(roomId) || { membership: 0, route: 0, topology: 0 };
    if (membershipChanged) epochs.membership += 1;
    epochs.route += 1;
    epochs.topology += 1;
    roomEpochs.set(roomId, epochs);
    const topology = buildRoomTopology(members, epochs, {
      enabled: config.peerMediaRelayEnabled,
      minimumParticipants: config.peerMediaRelayMinParticipants,
      maxChildren: config.peerMediaRelayMaxChildren,
      maxHops: config.peerMediaRelayMaxHops,
      leaseMs: config.peerRouteLeaseMs,
      blockedRelayIds: relayHealth.blockedRelayIds(roomId),
    });
    for (const member of members) safeSend(member.socket, topology);
    broadcastMediaAgentState(roomId);
  };

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/media-agent") {
      if (!mediaAgents.configured) {
        rejectUpgrade(socket, 403, "media_agents_disabled");
        return;
      }
      if (request.headers.origin || url.search || url.hash) {
        rejectUpgrade(socket, 403, "agent_origin_denied");
        return;
      }
      mediaAgentWebSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        mediaAgentWebSocketServer.emit("connection", webSocket, request);
      });
      return;
    }
    if (url.pathname !== "/signal") {
      rejectUpgrade(socket, 400, "invalid_endpoint");
      return;
    }
    if (!requestOriginAllowed(request, config)) {
      rejectUpgrade(socket, 403, "origin_denied");
      return;
    }
    let identity;
    try {
      identity = ticketStore.consume(url.searchParams.get("ticket") || "", {
        origin: request.headers.origin || "",
      });
    } catch (error) {
      rejectUpgrade(socket, error instanceof SessionTicketError ? 401 : 400, error.code || "invalid_join");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request, identity);
    });
  });

  webSocketServer.on("connection", (socket, _request, identity) => {
    let joined;
    try {
      joined = registry.join(identity.roomId, socket, identity.name, Date.now(), {
        mode: identity.mode,
        principal: identity.principal,
        deviceFingerprint: identity.deviceFingerprint,
        creatorPrincipal: directory.ownerPrincipal(identity.roomId),
      });
    } catch (error) {
      const code = error instanceof RoomFullError || error instanceof RoomAdmissionError
        ? error.code
        : "join_failed";
      safeSend(socket, { type: "error", code });
      socket.close(1008, code);
      return;
    }
    const { peer, existingPeers } = joined;
    directory.touch(peer.roomId);
    socket.isAlive = true;
    safeSend(socket, {
      type: "welcome",
      peerId: peer.id,
      roomId: peer.roomId,
      peers: existingPeers,
      maxParticipants: identity.mode === "pair" ? 2 : config.maxRoomParticipants,
      mode: identity.mode,
      authenticated: identity.authenticated,
      workspaceId: identity.workspaceId || "",
      workspaceRole: identity.workspaceRole || "",
      roomCreator: peer.creator,
      mediaAgents: mediaAgents.configuredForPrincipal(peer.principal),
    });
    for (const recipient of registry.recipients(peer)) {
      safeSend(recipient.socket, { type: "peer-joined", peer: { id: peer.id, name: peer.name } });
    }
    broadcastTopology(peer.roomId, true);

    socket.on("pong", () => { socket.isAlive = true; });
    socket.on("message", (raw, isBinary) => {
      try {
        if (isBinary) throw new ProtocolError("binary_signaling_unsupported");
        if (!registry.allowMessage(peer, Date.now(), { limit: config.signalRateLimit })) {
          throw new ProtocolError("rate_limited");
        }
        let message;
        try { message = parseClientMessage(raw); } catch (error) {
          if (!(error instanceof ProtocolError)) throw error;
          message = parseBrowserMediaAgentMessage(raw);
        }
        if (message.type === "signal") {
          const recipient = registry.recipient(peer, message.to);
          if (!recipient) throw new ProtocolError("recipient_unavailable");
          safeSend(recipient.socket, {
            ...message,
            from: peer.id,
            fromName: peer.name,
            to: undefined,
          });
          return;
        }
        if (message.type === "media-state") {
          registry.setMediaState(peer, message);
        }
        if (message.type === "media-agent-consent") {
          mediaAgents.setConsent(
            peer,
            message,
            directory.ownerPrincipal(peer.roomId) || registry.creatorPrincipal(peer.roomId),
          );
          broadcastMediaAgentState(peer.roomId);
          return;
        }
        if (message.type === "media-agent-takeover-response") {
          mediaAgents.respondToTakeover(peer, message);
          broadcastMediaAgentState(peer.roomId);
          return;
        }
        if (message.type === "media-agent-signal") {
          if (message.roomId !== peer.roomId
            || !mediaAgents.authorize(peer.roomId, message.agentId, message.routeEpoch, peer.id)) {
            throw new ProtocolError("stale_agent_route");
          }
          const agentSocket = mediaAgents.socketForAgent(message.agentId);
          if (!agentSocket) throw new ProtocolError("media_agent_unavailable");
          safeSend(agentSocket, {
            ...message,
            version: 1,
            type: "peer-signal",
            peerId: peer.id,
            agentId: undefined,
          });
          return;
        }
        if (message.type === "media-agent-peer-state") {
          if (message.roomId !== peer.roomId) throw new ProtocolError("invalid_agent_room");
          mediaAgents.setBrowserPeerState(
            peer.roomId, message.agentId, message.routeEpoch, peer.id, message.connected,
          );
          broadcastMediaAgentState(peer.roomId);
          return;
        }
        if (message.type === "media-agent-subscription-state") {
          if (message.roomId !== peer.roomId || message.publisherPeerId === peer.id
            || !mediaAgents.authorizePublisher(
              peer.roomId,
              message.agentId,
              message.routeEpoch,
              message.publisherPeerId,
            )) {
            throw new ProtocolError("stale_agent_route");
          }
          const publication = registry.publication(
            message.publisherPeerId, message.publicationId, message.roomId,
          );
          if (!publication) throw new ProtocolError("agent_publication_unauthorized");
          const publisher = registry.members(peer.roomId).find((member) => member.id === message.publisherPeerId);
          if (!publisher) throw new ProtocolError("recipient_unavailable");
          safeSend(publisher.socket, {
            version: 1,
            type: "media-agent-subscription-state",
            agentId: message.agentId,
            routeEpoch: message.routeEpoch,
            publicationId: message.publicationId,
            subscriberPeerId: peer.id,
            ready: message.ready,
          });
          return;
        }
        if (message.type === "relay-consent") {
          registry.setRelayConsent(peer, message.enabled);
          broadcastTopology(peer.roomId);
          return;
        }
        if (message.type === "relay-capability") {
          registry.setRelayCapability(peer, {
            visible: message.visible,
            battery: message.battery,
            network: message.network,
            selfCapacity: message.selfCapacity,
          });
          broadcastTopology(peer.roomId);
          return;
        }
        if (message.type === "relay-observation") {
          const epochs = roomEpochs.get(peer.roomId);
          if (!epochs || message.routeEpoch !== epochs.route) {
            throw new ProtocolError("stale_route_observation");
          }
          const relay = registry.members(peer.roomId).find((candidate) => (
            candidate.id === message.relayPeerId && candidate.id !== peer.id
          ));
          if (!relay) throw new ProtocolError("relay_unavailable");
          const unhealthy = relayHealth.observe(
            peer.roomId,
            peer.id,
            message,
            registry.members(peer.roomId).length,
          );
          if (unhealthy) {
            registry.updateObservedRelay(
              relay,
              message.observedCapacity,
              message.deliveryRatio,
            );
            broadcastTopology(peer.roomId);
          }
          return;
        }
        if (message.type === "overlay-key") {
          if (!config.peerDataOverlayEnabled) throw new ProtocolError("overlay_disabled");
          const epochs = roomEpochs.get(peer.roomId);
          if (!epochs) throw new ProtocolError("topology_unavailable");
          for (const recipient of registry.recipients(peer)) {
            safeSend(recipient.socket, { ...message, from: peer.id, membershipEpoch: epochs.membership });
          }
          return;
        }
        for (const recipient of registry.recipients(peer)) {
          safeSend(recipient.socket, { ...message, from: peer.id, fromName: peer.name });
        }
      } catch (error) {
        safeSend(socket, {
          type: "error",
          code: error instanceof ProtocolError ? error.code : "invalid_message",
        });
      }
    });

    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      relayHealth.leave(peer.roomId, peer.id);
      mediaAgents.leavePeer(peer);
      for (const recipient of registry.leave(peer)) {
        safeSend(recipient.socket, { type: "peer-left", peerId: peer.id });
      }
      directory.touch(peer.roomId);
      broadcastTopology(peer.roomId, true);
    };
    socket.on("close", leave);
    socket.on("error", leave);
  });

  mediaAgentWebSocketServer.on("connection", (socket) => {
    socket.isAlive = true;
    let authenticated = false;
    safeSend(socket, mediaAgents.issueChallenge(socket));
    const authTimeout = setTimeout(() => {
      if (!authenticated) socket.close(1008, "agent_authentication_timeout");
    }, 31_000);
    authTimeout.unref();
    socket.on("pong", () => { socket.isAlive = true; });
    socket.on("message", (raw, isBinary) => {
      try {
        if (isBinary) throw new ProtocolError("binary_agent_signaling_unsupported");
        const message = parseMediaAgentMessage(raw);
        if (!authenticated) {
          if (message.type !== "authenticate") throw new ProtocolError("agent_authentication_required");
          const result = mediaAgents.authenticate(socket, message);
          authenticated = true;
          clearTimeout(authTimeout);
          result.replacedSocket?.close(1008, "agent_connection_replaced");
          safeSend(socket, { version: 1, type: "agent-authenticated", agentId: result.id });
          const connection = mediaAgents.connection(socket);
          if (connection) broadcastPrincipalMediaAgentAvailability(connection.ownerPrincipal);
          for (const roomId of mediaAgents.roomsAffectedByAgent(result.id)) broadcastMediaAgentState(roomId);
          syncAgents();
          return;
        }
        if (!mediaAgents.allowMessage(socket, Date.now(), { limit: config.mediaAgentRateLimit })) {
          throw new ProtocolError("agent_rate_limited");
        }
        const connection = mediaAgents.connection(socket);
        if (!connection) throw new ProtocolError("agent_not_authenticated");
        if (message.type === "authenticate") throw new ProtocolError("agent_already_authenticated");
        if (message.type === "capability") {
          for (const roomId of mediaAgents.setCapability(socket, message)) broadcastMediaAgentState(roomId);
          return;
        }
        if (message.type === "heartbeat") {
          mediaAgents.heartbeat(socket, message.rooms);
          return;
        }
        if (message.type === "draining") {
          for (const roomId of mediaAgents.setDraining(socket, message.enabled)) broadcastMediaAgentState(roomId);
          return;
        }
        if (message.type === "media-agent-signal") {
          if (!mediaAgents.authorize(message.roomId, connection.id, message.routeEpoch, message.peerId)) {
            throw new ProtocolError("stale_agent_route");
          }
          const recipient = registry.members(message.roomId).find((peer) => peer.id === message.peerId);
          if (!recipient) throw new ProtocolError("recipient_unavailable");
          safeSend(recipient.socket, {
            ...message,
            version: 1,
            agentId: connection.id,
            peerId: undefined,
          });
          return;
        }
        if (message.type === "peer-state") {
          if (!registry.members(message.roomId).some((peer) => peer.id === message.peerId)) {
            throw new ProtocolError("recipient_unavailable");
          }
          mediaAgents.setAgentPeerState(
            socket, message.roomId, message.peerId, message.routeEpoch, message.connected,
          );
          broadcastMediaAgentState(message.roomId);
          return;
        }
        if (message.type === "track-state") {
          if (!mediaAgents.authorizePublisher(
            message.roomId,
            connection.id,
            message.routeEpoch,
            message.peerId,
          )) {
            throw new ProtocolError("stale_agent_route");
          }
          const trackKey = `${message.roomId}\0${connection.id}\0${message.peerId}\0${message.publicationId}`;
          const publication = registry.publication(message.peerId, message.publicationId, message.roomId);
          const source = publication?.source || mediaAgentTracks.get(trackKey);
          if (message.active && !publication) {
            throw new ProtocolError("agent_publication_unauthorized");
          }
          if (!source) throw new ProtocolError("agent_publication_unauthorized");
          if (message.active) mediaAgentTracks.set(trackKey, source);
          else mediaAgentTracks.delete(trackKey);
          for (const recipient of registry.members(message.roomId)) {
            safeSend(recipient.socket, {
              version: 1,
              type: "media-agent-track-state",
              agentId: connection.id,
              routeEpoch: message.routeEpoch,
              peerId: message.peerId,
              publicationId: message.publicationId,
              source,
              active: message.active,
            });
          }
          return;
        }
        throw new ProtocolError("unknown_agent_message_type");
      } catch (error) {
        safeSend(socket, {
          version: 1,
          type: "agent-error",
          code: error instanceof ProtocolError ? error.code : "invalid_agent_message",
        });
      }
    });
    let closed = false;
    const disconnect = () => {
      if (closed) return;
      closed = true;
      clearTimeout(authTimeout);
      const connection = mediaAgents.connection(socket);
      for (const roomId of mediaAgents.disconnect(socket)) broadcastMediaAgentState(roomId);
      if (connection) broadcastPrincipalMediaAgentAvailability(connection.ownerPrincipal);
    };
    socket.on("close", disconnect);
    socket.on("error", disconnect);
  });

  const heartbeat = setInterval(() => {
    for (const socket of [...webSocketServer.clients, ...mediaAgentWebSocketServer.clients]) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
    registry.prune();
    directory.prune(Date.now(), (roomId) => registry.members(roomId).length > 0);
    ticketStore.prune();
  }, 30_000);
  heartbeat.unref();
  const leaseRenewal = setInterval(() => {
    for (const roomId of roomEpochs.keys()) broadcastTopology(roomId);
  }, config.peerRouteRenewMs);
  leaseRenewal.unref();
  const mediaAgentRenewal = setInterval(() => {
    for (const roomId of roomEpochs.keys()) broadcastMediaAgentState(roomId);
  }, config.mediaAgentRenewMs);
  mediaAgentRenewal.unref();
  server.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(leaseRenewal);
    clearInterval(mediaAgentRenewal);
    for (const socket of mediaAgentWebSocketServer.clients) socket.terminate();
  });
  return { webSocketServer, mediaAgentWebSocketServer };
}

export function createAppServer(options = {}) {
  const config = options.config
    ? Object.freeze({ ...loadConfig({}), ...options.config })
    : loadConfig(options.env);
  const registry = options.registry || new RoomRegistry({
    maxParticipants: config.maxRoomParticipants,
    idleTtlMs: config.roomIdleTtlMs,
  });
  const directory = options.directory || new RoomDirectory({
    maxParticipants: config.maxRoomParticipants,
    idleTtlMs: config.roomIdleTtlMs,
  });
  const oidcVerifier = options.oidcVerifier || createOidcVerifier(config);
  const deviceProofVerifier = options.deviceProofVerifier || new DeviceProofVerifier({
    maxAgeMs: config.deviceProofMaxAgeMs,
  });
  const ticketStore = options.ticketStore || new SessionTicketStore({ ttlMs: config.sessionTicketTtlMs });
  const mediaAgents = options.mediaAgents || new MediaAgentRegistry({
    definitions: config.mediaAgents,
    leaseMs: config.mediaAgentLeaseMs,
    maxStandbys: config.mediaAgentMaxStandbys,
    shardMinParticipants: config.mediaAgentShardMinParticipants,
    takeoverTtlMs: config.mediaAgentTakeoverTtlMs,
  });
  const workspaceStore = options.workspaceStore || (config.pairWorkspaceEnabled
    ? new PairWorkspaceStore({ filename: config.pairWorkspaceDb }) : null);
  const publicDir = path.resolve(options.publicDir || DEFAULT_PUBLIC_DIR);
  const services = { oidcVerifier, deviceProofVerifier, ticketStore, workspaceStore, directory, publicDir };
  const server = http.createServer(createHttpHandler(config, registry, services));
  if (!options.workspaceStore && workspaceStore) server.on("close", () => workspaceStore.close());
  const signaling = configureSignaling(server, config, registry, ticketStore, directory, mediaAgents);
  return {
    server,
    ...signaling,
    config,
    registry,
    directory,
    ticketStore,
    workspaceStore,
    mediaAgents,
  };
}

export async function startServer(options = {}) {
  const app = createAppServer(options);
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(app.config.port, app.config.host, resolve);
  });
  const address = app.server.address();
  console.log(`WebRTC room server listening on http://${app.config.host}:${address.port}`);
  return app;
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
