import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

import { loadConfig } from "./config.js";
import {
  encodeServerMessage,
  normalizeDisplayName,
  normalizeRoomId,
  parseClientMessage,
  ProtocolError,
} from "./protocol.js";
import { RoomFullError, RoomRegistry } from "./room-registry.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(MODULE_DIR, "../public");
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

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

function securityHeaders() {
  return {
    "content-security-policy": [
      "default-src 'self'",
      "connect-src 'self' ws: wss:",
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
  };
}

async function serveStatic(request, response, pathname) {
  let requestedPath;
  try {
    requestedPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    sendJson(response, 400, { error: "invalid_path" });
    return;
  }
  const absolutePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
  if (absolutePath !== PUBLIC_DIR && !absolutePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  try {
    const content = await fs.readFile(absolutePath);
    response.writeHead(200, {
      "content-type": MIME_TYPES.get(path.extname(absolutePath)) || "application/octet-stream",
      "content-length": content.length,
      "cache-control": requestedPath === "/index.html" ? "no-cache" : "public, max-age=300",
      ...securityHeaders(),
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      sendJson(response, 404, { error: "not_found" }, securityHeaders());
      return;
    }
    throw error;
  }
}

function createHttpHandler(config, registry) {
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
        sendJson(response, 200, publicRuntimeConfig(config), securityHeaders());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/rooms") {
        const roomId = `room-${crypto.randomBytes(9).toString("hex")}`;
        const origin = config.publicOrigin || `${request.socket.encrypted ? "https" : "http"}://${request.headers.host}`;
        sendJson(response, 201, {
          roomId,
          inviteUrl: `${origin}/?room=${encodeURIComponent(roomId)}`,
        }, securityHeaders());
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "method_not_allowed" }, {
          allow: "GET, HEAD",
          ...securityHeaders(),
        });
        return;
      }
      await serveStatic(request, response, url.pathname);
    } catch (error) {
      console.error("HTTP request failed", error);
      if (!response.headersSent) sendJson(response, 500, { error: "internal_error" }, securityHeaders());
      else response.destroy();
    }
  };
}

function rejectUpgrade(socket, statusCode, message) {
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusCode === 403 ? "Forbidden" : "Bad Request"}\r\n` +
    "Content-Type: application/json\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "Connection: close\r\n\r\n" +
    body,
  );
}

function configureSignaling(server, config, registry) {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024 });

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
    let roomId;
    let name;
    try {
      roomId = normalizeRoomId(url.searchParams.get("room"));
      name = normalizeDisplayName(url.searchParams.get("name"));
    } catch (error) {
      rejectUpgrade(socket, 400, error.code || "invalid_join");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request, { roomId, name });
    });
  });

  webSocketServer.on("connection", (socket, _request, identity) => {
    let joined;
    try {
      joined = registry.join(identity.roomId, socket, identity.name);
    } catch (error) {
      safeSend(socket, { type: "error", code: error instanceof RoomFullError ? error.code : "join_failed" });
      socket.close(1008, error instanceof RoomFullError ? error.code : "join_failed");
      return;
    }
    const { peer, existingPeers } = joined;
    socket.isAlive = true;
    safeSend(socket, {
      type: "welcome",
      peerId: peer.id,
      roomId: peer.roomId,
      peers: existingPeers,
      maxParticipants: config.maxRoomParticipants,
    });
    for (const recipient of registry.recipients(peer)) {
      safeSend(recipient.socket, { type: "peer-joined", peer: { id: peer.id, name: peer.name } });
    }

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
  }, 30_000);
  heartbeat.unref();
  server.on("close", () => clearInterval(heartbeat));
  return webSocketServer;
}

export function createAppServer(options = {}) {
  const config = options.config || loadConfig(options.env);
  const registry = options.registry || new RoomRegistry({
    maxParticipants: config.maxRoomParticipants,
    idleTtlMs: config.roomIdleTtlMs,
  });
  const server = http.createServer(createHttpHandler(config, registry));
  const webSocketServer = configureSignaling(server, config, registry);
  return { server, webSocketServer, config, registry };
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
