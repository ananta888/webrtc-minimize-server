import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

import { loadConfig } from "./config.js";
import { DeviceProofError, DeviceProofVerifier } from "./device-proof.js";
import { buildRoomTopology } from "./media-topology.js";
import { AuthenticationError, bearerToken, createOidcVerifier } from "./oidc-verifier.js";
import {
  encodeServerMessage,
  normalizeDisplayName,
  normalizeRoomId,
  parseClientMessage,
  ProtocolError,
} from "./protocol.js";
import { RoomAdmissionError, RoomFullError, RoomRegistry } from "./room-registry.js";
import { SessionTicketError, SessionTicketStore } from "./session-tickets.js";
import { createTurnCredentials } from "./turn-credentials.js";

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
const ROOM_REQUEST_FIELDS = new Set(["mode"]);
const SESSION_REQUEST_FIELDS = new Set(["roomId", "displayName", "mode", "deviceProof"]);

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
    optimization: {
      activeSpeakerLimit: config.activeSpeakerLimit,
      peerRelayEnabled: config.peerMediaRelayEnabled,
      peerRelayMinParticipants: config.peerMediaRelayMinParticipants,
      peerRelayMaxChildren: config.peerMediaRelayMaxChildren,
      peerRelayMaxHops: config.peerMediaRelayMaxHops,
    },
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

function errorStatus(error) {
  if (error instanceof AuthenticationError) return 401;
  if (error instanceof ProtocolError || error instanceof DeviceProofError) return 400;
  return 500;
}

function createHttpHandler(config, registry, services) {
  const { oidcVerifier, deviceProofVerifier, ticketStore, publicDir } = services;
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
      if (request.method === "POST" && url.pathname === "/api/rooms") {
        if (!requestOriginAllowed(request, config)) throw new ProtocolError("origin_denied");
        await authenticateRequest(request, config, oidcVerifier);
        const input = await readJsonBody(request);
        assertAllowedKeys(input, ROOM_REQUEST_FIELDS);
        const mode = normalizeMode(input.mode);
        const roomId = `${mode}-${crypto.randomBytes(9).toString("hex")}`;
        const origin = requestOrigin(request, config);
        sendJson(response, 201, {
          roomId,
          mode,
          inviteUrl: `${origin}/?room=${encodeURIComponent(roomId)}&mode=${mode}`,
        }, securityHeaders(config));
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
        const origin = requestOrigin(request, config);
        const issued = ticketStore.issue({
          roomId,
          mode,
          name: authorizedName,
          principal,
          authenticated: Boolean(identity),
          deviceFingerprint: device.fingerprint,
          origin,
        });
        sendJson(response, 201, {
          ticket: issued.ticket,
          expiresAt: issued.expiresAt,
          signalingPath: `/signal?ticket=${encodeURIComponent(issued.ticket)}`,
          identity: identity ? { authenticated: true, displayName: identity.displayName } : { authenticated: false },
          iceServers: [
            ...config.stunUrls.map((urls) => ({ urls })),
            ...config.turnServers,
            ...createTurnCredentials(config, principal),
          ],
        }, securityHeaders(config));
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "method_not_allowed" }, {
          allow: "GET, HEAD, POST",
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

function configureSignaling(server, config, registry, ticketStore) {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024 });
  const topologyEpochs = new Map();

  const broadcastTopology = (roomId) => {
    const members = registry.members(roomId);
    if (members.length === 0) {
      topologyEpochs.delete(roomId);
      return;
    }
    const epoch = (topologyEpochs.get(roomId) || 0) + 1;
    topologyEpochs.set(roomId, epoch);
    const topology = buildRoomTopology(members, epoch, {
      enabled: config.peerMediaRelayEnabled,
      minimumParticipants: config.peerMediaRelayMinParticipants,
      maxChildren: config.peerMediaRelayMaxChildren,
      maxHops: config.peerMediaRelayMaxHops,
    });
    for (const member of members) safeSend(member.socket, topology);
  };

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
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
    socket.isAlive = true;
    safeSend(socket, {
      type: "welcome",
      peerId: peer.id,
      roomId: peer.roomId,
      peers: existingPeers,
      maxParticipants: identity.mode === "pair" ? 2 : config.maxRoomParticipants,
      mode: identity.mode,
      authenticated: identity.authenticated,
    });
    for (const recipient of registry.recipients(peer)) {
      safeSend(recipient.socket, { type: "peer-joined", peer: { id: peer.id, name: peer.name } });
    }
    broadcastTopology(peer.roomId);

    socket.on("pong", () => { socket.isAlive = true; });
    socket.on("message", (raw, isBinary) => {
      try {
        if (isBinary) throw new ProtocolError("binary_signaling_unsupported");
        if (!registry.allowMessage(peer, Date.now(), { limit: config.signalRateLimit })) {
          throw new ProtocolError("rate_limited");
        }
        const message = parseClientMessage(raw);
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
        if (message.type === "relay-consent") {
          registry.setRelayConsent(peer, message.enabled);
          broadcastTopology(peer.roomId);
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
      for (const recipient of registry.leave(peer)) {
        safeSend(recipient.socket, { type: "peer-left", peerId: peer.id });
      }
      broadcastTopology(peer.roomId);
    };
    socket.on("close", leave);
    socket.on("error", leave);
  });

  const heartbeat = setInterval(() => {
    for (const socket of webSocketServer.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
    registry.prune();
    ticketStore.prune();
  }, 30_000);
  heartbeat.unref();
  server.on("close", () => clearInterval(heartbeat));
  return webSocketServer;
}

export function createAppServer(options = {}) {
  const config = options.config
    ? Object.freeze({ ...loadConfig({}), ...options.config })
    : loadConfig(options.env);
  const registry = options.registry || new RoomRegistry({
    maxParticipants: config.maxRoomParticipants,
    idleTtlMs: config.roomIdleTtlMs,
  });
  const oidcVerifier = options.oidcVerifier || createOidcVerifier(config);
  const deviceProofVerifier = options.deviceProofVerifier || new DeviceProofVerifier({
    maxAgeMs: config.deviceProofMaxAgeMs,
  });
  const ticketStore = options.ticketStore || new SessionTicketStore({ ttlMs: config.sessionTicketTtlMs });
  const publicDir = path.resolve(options.publicDir || DEFAULT_PUBLIC_DIR);
  const services = { oidcVerifier, deviceProofVerifier, ticketStore, publicDir };
  const server = http.createServer(createHttpHandler(config, registry, services));
  const webSocketServer = configureSignaling(server, config, registry, ticketStore);
  return { server, webSocketServer, config, registry, ticketStore };
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
