import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

import { loadConfig } from "./config.js";
import { DeviceProofError, DeviceProofVerifier } from "./device-proof.js";
import { MediaAgentEnrollmentError, MediaAgentEnrollmentStore } from "./media-agent-enrollment-store.js";
import { MediaAgentInstallerError, MediaAgentInstallerService } from "./media-agent-installers.js";
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
import { createMediaAgentIceServers } from "./media-agent-ice.js";
import { createEdgeTurnCredentials, createTurnCredentials } from "./turn-credentials.js";
import { MediaMtxExternalAuthError, MediaMtxExternalAuthService } from "./mediamtx-external-auth.js";
import { BroadcastHlsProxy, BroadcastHlsProxyError } from "./broadcast-hls-proxy.js";
import {
  BroadcastPlaybackSessionError,
  BroadcastPlaybackSessionStore,
} from "./broadcast-playback-session-store.js";
import { BroadcastAbuseGuard } from "./broadcast-admission-control.js";
import { BroadcastHealthRegistry } from "./broadcast-observability.js";
import { BroadcastRuntimeError, BroadcastRuntimeRegistry } from "./broadcast-runtime-registry.js";
import { broadcastSubjectRef, broadcastTenantRef } from "./broadcast-identifiers.js";
import { BroadcastAudienceError } from "./broadcast-action-policy.js";
import { BroadcastGrantAuthority, BroadcastGrantError } from "./broadcast-grant-authority.js";
import { BroadcastDeviceProofError } from "./broadcast-device-proof.js";
import {
  NativePackagerEnrollmentError,
  NativePackagerEnrollmentStore,
} from "./native-packager-enrollment-store.js";
import {
  NativePackagerControlError,
  NativePackagerControlRegistry,
  parseNativePackagerMessage,
} from "./native-packager-control.js";
import {
  NativePackagerInstallerError,
  NativePackagerInstallerService,
} from "./native-packager-installers.js";
import {
  NativePackagerAssignmentError,
  NativePackagerAssignmentRegistry,
} from "./native-packager-assignment.js";

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
const MAX_MEDIA_AGENT_SYNC_BYTES = 32 * 1024 * 1024;
const ROOM_REQUEST_FIELDS = new Set(["mode", "persistent", "title", "visibility"]);
const ROOM_UPDATE_FIELDS = new Set(["title", "visibility"]);
const SESSION_REQUEST_FIELDS = new Set(["roomId", "displayName", "mode", "deviceProof", "workspaceInvite"]);
const EVENT_REQUEST_FIELDS = new Set(["eventId", "correlationId", "kind", "payload"]);
const CURSOR_REQUEST_FIELDS = new Set(["sequence"]);
const PRESENCE_REQUEST_FIELDS = new Set(["state", "documentId", "line", "column", "leaseId", "epoch", "ttlMs"]);
const ROLE_REQUEST_FIELDS = new Set(["principal", "role", "expectedRevision"]);
const MEDIA_AGENT_ENROLLMENT_FIELDS = new Set(["label", "target"]);
const NATIVE_PACKAGER_ENROLLMENT_FIELDS = new Set(["label", "target"]);

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

function securityHeaders(config, { voskWorker = false } = {}) {
  const connectSources = ["'self'", "ws:", "wss:", "https://raw.githubusercontent.com"];
  if (voskWorker) connectSources.push("blob:");
  if (config.oidcIssuer) connectSources.push(new URL(config.oidcIssuer).origin);
  return {
    "content-security-policy": [
      "default-src 'self'",
      `connect-src ${connectSources.join(" ")}`,
      `script-src 'self' 'wasm-unsafe-eval'${voskWorker ? " 'unsafe-eval'" : ""}`,
      "worker-src 'self' blob:",
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

function safeSend(socket, message, maximumBytes = Number.POSITIVE_INFINITY) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  const encoded = encodeServerMessage(message);
  if (Buffer.byteLength(encoded) > maximumBytes) {
    socket.close(1009, "server control message too large");
    return false;
  }
  socket.send(encoded);
  return true;
}

function publicRuntimeConfig(config, services = {}) {
  const targets = services.mediaAgentInstallerService?.availableTargets() || [];
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
      frameEnvelope: "codec-prefix-v1",
    },
    mediaAgents: {
      configured: services.mediaAgents?.configured || config.mediaAgents.length > 0,
      selfService: config.mediaAgentSelfServiceEnabled,
      targets,
      unsignedArtifacts: targets.length > 0,
      leaseMs: config.mediaAgentLeaseMs,
      maxStandbys: config.mediaAgentMaxStandbys,
      minimumParticipants: config.mediaAgentMinParticipants,
      shardMinParticipants: config.mediaAgentShardMinParticipants,
    },
    nativePackagers: {
      selfService: config.nativePackagerSelfServiceEnabled,
      configured: Boolean(services.nativePackagers?.configured),
      publicationEnabled: Boolean(config.nativePackagerSelfServiceEnabled && services.broadcastRuntime),
      endpoint: config.nativePackagerSelfServiceEnabled ? "/native-packager" : "",
      targets: services.nativePackagerInstallerService?.availableTargets() || [],
    },
    broadcast: {
      whip: {
        configurationVersion: 1,
        compatibilityProfile: config.broadcastWhipProfile,
        enabled: Boolean(config.broadcastWhipEndpoint && services.broadcastRuntime),
        endpointUrl: config.broadcastWhipEndpoint,
        allowedRedirectOrigins: config.broadcastWhipRedirectOrigins,
        trickleIce: config.broadcastWhipTrickleIce,
        simulcast: config.broadcastWhipSimulcastEnabled ? {
          enabled: true,
          sendEncodings: [
            { rid: "q", active: true, maxBitrate: 120_000, maxFramerate: 6, scaleResolutionDownBy: 4 },
            { rid: "h", active: true, maxBitrate: 420_000, maxFramerate: 15, scaleResolutionDownBy: 2 },
            { rid: "f", active: true, maxBitrate: 1_200_000, maxFramerate: 24, scaleResolutionDownBy: 1 },
          ],
        } : { enabled: false, sendEncodings: [] },
        codecPreferences: {
          audio: config.broadcastWhipAudioCodecs,
          video: config.broadcastWhipVideoCodecs,
        },
        requestTimeoutMs: config.broadcastWhipRequestTimeoutMs,
        iceGatheringTimeoutMs: config.broadcastWhipIceGatheringTimeoutMs,
        connectionTimeoutMs: config.broadcastWhipConnectionTimeoutMs,
        maximumResponseBytes: 128 * 1024,
        maximumSdpBytes: 64 * 1024,
        maximumIceFragmentBytes: 16 * 1024,
        maximumCandidates: 64,
        retryBudget: config.broadcastWhipRetryBudget,
      },
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
      ...securityHeaders(config, { voskWorker: requestedPath === "/assets/vosk-worker.js" }),
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

function identityForPrincipal(principal) {
  const value = String(principal || "");
  const separator = value.lastIndexOf("|");
  if (separator < 1 || separator === value.length - 1) return null;
  return Object.freeze({ issuer: value.slice(0, separator), subject: value.slice(separator + 1) });
}

function stopProgramForPrincipal(broadcastRuntime, principal, programId) {
  const identity = identityForPrincipal(principal);
  if (!broadcastRuntime || !identity) return;
  try { broadcastRuntime.stopProgram(identity, programId); } catch { /* fail closed during transport cleanup */ }
}

function errorStatus(error) {
  if (error instanceof RoomDirectoryError) return error.status;
  if (error instanceof PairWorkspaceError) return error.status;
  if (error instanceof MediaAgentEnrollmentError || error instanceof MediaAgentInstallerError) return error.status;
  if (error instanceof NativePackagerEnrollmentError || error instanceof NativePackagerControlError
    || error instanceof NativePackagerAssignmentError
    || error instanceof NativePackagerInstallerError) return error.status;
  if (error instanceof MediaMtxExternalAuthError) return error.status;
  if (error instanceof BroadcastHlsProxyError || error instanceof BroadcastPlaybackSessionError) return error.status;
  if (error instanceof BroadcastRuntimeError) return error.status;
  if (error instanceof BroadcastAudienceError || error instanceof BroadcastGrantError) return error.status;
  if (error instanceof BroadcastDeviceProofError) return 400;
  if (error instanceof AuthenticationError) return 401;
  if (error instanceof ProtocolError || error instanceof DeviceProofError) return 400;
  return 500;
}

function createHttpHandler(config, registry, services) {
  const {
    oidcVerifier,
    deviceProofVerifier,
    ticketStore,
    workspaceStore,
    directory,
    publicDir,
    mediaAgents,
    mediaAgentEnrollmentStore,
    mediaAgentInstallerService,
    mediaAgentEvents,
    nativePackagers,
    nativePackagerEnrollmentStore,
    nativePackagerInstallerService,
    nativePackagerAssignments,
    mediaMtxExternalAuthService,
    broadcastHlsProxy,
    broadcastAbuseGuard,
    broadcastHealthRegistry,
    broadcastRuntime,
  } = services;
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
        sendJson(response, 200, publicRuntimeConfig(config, services), securityHeaders(config));
        return;
      }
      const nativePackagerArtifactMatch = url.pathname.match(
        /^\/downloads\/native-packager\/([a-z0-9-]+)$/,
      );
      if (nativePackagerArtifactMatch && request.method === "GET") {
        if (!config.nativePackagerSelfServiceEnabled || !nativePackagerInstallerService) {
          throw new NativePackagerInstallerError("native_packager_artifact_unavailable", 404);
        }
        const artifact = nativePackagerInstallerService.artifact(nativePackagerArtifactMatch[1]);
        const file = await fs.open(artifact.filename, "r");
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== artifact.size) {
          await file.close();
          throw new NativePackagerInstallerError("native_packager_artifact_unavailable", 503);
        }
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": artifact.size,
          "content-disposition": `attachment; filename="${artifact.artifact}"`,
          "cache-control": "public, max-age=300, immutable",
          "x-content-sha256": artifact.sha256,
          ...securityHeaders(config),
        });
        const stream = file.createReadStream();
        stream.on("error", () => response.destroy());
        stream.pipe(response);
        return;
      }
      if (url.pathname === "/api/native-packagers" && request.method === "GET") {
        if (url.search || !config.nativePackagerSelfServiceEnabled || !nativePackagerEnrollmentStore) {
          throw new NativePackagerEnrollmentError("native_packager_self_service_disabled", 404);
        }
        const identity = await authenticateRequest(request, config, oidcVerifier);
        const ownerPrincipal = principalFor(identity);
        const registrations = new Map(nativePackagerEnrollmentStore.list(ownerPrincipal)
          .map((item) => [item.id, item]));
        sendJson(response, 200, {
          packagers: nativePackagers.list(ownerPrincipal).map((item) => ({
            ...registrations.get(item.id),
            ...item,
          })),
          assignments: nativePackagerAssignments.list(ownerPrincipal),
        }, securityHeaders(config));
        return;
      }
      if (url.pathname === "/api/native-packagers/enrollments" && request.method === "POST") {
        if (!config.nativePackagerSelfServiceEnabled || !nativePackagerEnrollmentStore
          || !nativePackagerInstallerService || url.search
          || request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          throw new NativePackagerEnrollmentError("native_packager_self_service_disabled", 404);
        }
        if (!requestOriginAllowed(request, config)) throw new ProtocolError("origin_denied");
        const identity = await authenticateRequest(request, config, oidcVerifier);
        const input = await readJsonBody(request);
        assertAllowedKeys(input, NATIVE_PACKAGER_ENROLLMENT_FIELDS);
        const target = nativePackagerInstallerService.target(input.target);
        const enrollment = nativePackagerEnrollmentStore.createEnrollment({
          ownerPrincipal: principalFor(identity),
          label: input.label,
          platform: target.platform,
        });
        const installer = nativePackagerInstallerService.installer({
          enrollment,
          targetId: target.id,
          publicOrigin: config.publicOrigin,
          stunUrls: config.stunUrls,
        });
        sendJson(response, 201, {
          packagerId: enrollment.packagerId,
          expiresAt: enrollment.expiresAt,
          target: installer.target,
          filename: installer.filename,
          artifactSha256: installer.artifactSha256,
          artifactBytes: installer.artifactBytes,
          installer: installer.content,
        }, securityHeaders(config));
        return;
      }
      const nativePackagerConsentMatch = url.pathname.match(
        /^\/api\/native-packagers\/(pkr_[A-Za-z0-9_-]{16,64})\/room-consents\/([A-Za-z0-9_-]{4,64})$/,
      );
      if (nativePackagerConsentMatch && request.method === "PUT") {
        if (!config.nativePackagerSelfServiceEnabled || url.search
          || !requestOriginAllowed(request, config)
          || request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          throw new NativePackagerEnrollmentError("native_packager_self_service_disabled", 404);
        }
        const identity = await authenticateRequest(request, config, oidcVerifier);
        const input = await readJsonBody(request);
        assertAllowedKeys(input, new Set(["enabled"]));
        if (!registry.membersForPrincipal(principalFor(identity))
          .some(({ roomId }) => roomId === nativePackagerConsentMatch[2])) {
          throw new NativePackagerControlError("native_packager_room_membership_required", 403);
        }
        const consent = nativePackagers.consent(
          principalFor(identity),
          nativePackagerConsentMatch[1],
          nativePackagerConsentMatch[2],
          input.enabled,
        );
        safeSend(nativePackagers.socketFor(nativePackagerConsentMatch[1]),
          nativePackagers.consentState(nativePackagerConsentMatch[1]));
        if (!input.enabled) {
          const activeAssignment = nativePackagerAssignments.activeForPackager(nativePackagerConsentMatch[1]);
          if (activeAssignment?.roomId === nativePackagerConsentMatch[2]) {
            const stoppedAssignment = nativePackagerAssignments.stop(
              principalFor(identity), activeAssignment.packagerId, activeAssignment.assignmentId, "CONSENT_REVOKED",
            );
            safeSend(nativePackagers.socketFor(activeAssignment.packagerId), stoppedAssignment.command);
            broadcastRuntime?.stopProgram(identity, activeAssignment.programId);
          }
        }
        sendJson(response, 200, consent, securityHeaders(config));
        return;
      }
      const nativePackagerMatch = url.pathname.match(
        /^\/api\/native-packagers\/(pkr_[A-Za-z0-9_-]{16,64})$/,
      );
      if (nativePackagerMatch && request.method === "DELETE") {
        if (!config.nativePackagerSelfServiceEnabled || !nativePackagerEnrollmentStore
          || url.search || !requestOriginAllowed(request, config)) {
          throw new NativePackagerEnrollmentError("native_packager_self_service_disabled", 404);
        }
        const identity = await authenticateRequest(request, config, oidcVerifier);
        const revoked = nativePackagers.revoke(principalFor(identity), nativePackagerMatch[1]);
        const failedAssignment = nativePackagerAssignments.failPackager(
          revoked.packagerId, "PACKAGER_REVOKED",
        );
        if (failedAssignment) broadcastRuntime?.stopProgram(identity, failedAssignment.programId);
        revoked.socket?.close(1008, "native_packager_revoked");
        sendJson(response, 200, {
          packagerId: revoked.packagerId,
          revokedAt: revoked.revokedAt,
        }, securityHeaders(config));
        return;
      }
      const nativePackagerAssignmentMatch = url.pathname.match(
        /^\/api\/native-packagers\/(pkr_[A-Za-z0-9_-]{16,64})\/assignments\/(asn_[A-Za-z0-9_-]{16,64})$/,
      );
      if (nativePackagerAssignmentMatch && request.method === "DELETE") {
        if (!config.nativePackagerSelfServiceEnabled || url.search || !requestOriginAllowed(request, config)) {
          throw new NativePackagerEnrollmentError("native_packager_self_service_disabled", 404);
        }
        const identity = await authenticateRequest(request, config, oidcVerifier);
        const ownerPrincipal = principalFor(identity);
        nativePackagers.candidate(ownerPrincipal, nativePackagerAssignmentMatch[1]);
        const stopped = nativePackagerAssignments.stop(
          ownerPrincipal,
          nativePackagerAssignmentMatch[1],
          nativePackagerAssignmentMatch[2],
          "OWNER_STOP",
        );
        if (stopped.command) {
          safeSend(nativePackagers.socketFor(nativePackagerAssignmentMatch[1]), stopped.command);
          broadcastRuntime?.stopProgram(identity, stopped.snapshot.programId);
        }
        sendJson(response, 200, { assignment: stopped.snapshot }, securityHeaders(config));
        return;
      }
      if (url.pathname.startsWith("/api/native-packagers/")) {
        response.writeHead(404, { "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        const observedAt = Date.now();
        broadcastHealthRegistry.update({
          component: "control-plane", status: "healthy", reasonCode: "READY", observedAt,
        });
        const readiness = broadcastHealthRegistry.snapshot(observedAt);
        sendJson(response, readiness.status === "ok" ? 200 : 503, readiness, securityHeaders(config));
        return;
      }
      if (url.pathname === "/api/broadcasts/public") {
        if (!broadcastRuntime || request.method !== "GET" || url.search) {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        sendJson(response, 200, {
          programs: broadcastRuntime.listPublic(broadcastTenantRef(config.oidcIssuer)),
        }, securityHeaders(config));
        return;
      }
      if (url.pathname === "/api/broadcasts/mine") {
        if (!broadcastRuntime || request.method !== "GET" || url.search) {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const identity = await authenticateRequest(request, config, oidcVerifier);
        sendJson(response, 200, broadcastRuntime.listMine(identity), securityHeaders(config));
        return;
      }
      if (url.pathname === "/api/broadcasts") {
        if (!broadcastRuntime || request.method !== "POST" || url.search
          || !requestOriginAllowed(request, config)
          || request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const identity = await authenticateRequest(request, config, oidcVerifier);
        const input = await readJsonBody(request);
        const member = registry.membersForPrincipal(principalFor(identity)).find(
          (candidate) => candidate.roomId === String(input.roomId || ""),
        );
        const created = broadcastRuntime.createProgram(identity, member, input);
        sendJson(response, 201, created, securityHeaders(config));
        return;
      }
      const broadcastPublisherChallengeMatch = url.pathname.match(
        /^\/api\/broadcasts\/(prg_[A-Za-z0-9_-]{16,64})\/publisher-challenges$/,
      );
      if (broadcastPublisherChallengeMatch) {
        if (!broadcastRuntime || request.method !== "POST" || url.search
          || !requestOriginAllowed(request, config)
          || request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const identity = await authenticateRequest(request, config, oidcVerifier);
        const input = await readJsonBody(request);
        assertAllowedKeys(input, new Set(["requestVersion", "action", "sourceIds", "deviceFingerprint"]));
        if (!/^[A-Za-z0-9_-]{43}$/.test(input.deviceFingerprint || "")) {
          throw new BroadcastRuntimeError("invalid_broadcast_device_fingerprint");
        }
        const activeMember = registry.membersForPrincipal(principalFor(identity))
          .find((candidate) => candidate.deviceFingerprint === input.deviceFingerprint);
        const challenge = broadcastRuntime.createPublisherChallenge(
          identity,
          activeMember,
          broadcastPublisherChallengeMatch[1],
          { requestVersion: input.requestVersion, action: input.action, sourceIds: input.sourceIds },
        );
        sendJson(response, 201, challenge, securityHeaders(config));
        return;
      }
      const broadcastPublisherAuthorizationMatch = url.pathname.match(
        /^\/api\/broadcasts\/(prg_[A-Za-z0-9_-]{16,64})\/publisher-authorizations$/,
      );
      if (broadcastPublisherAuthorizationMatch) {
        if (!broadcastRuntime || request.method !== "POST" || url.search
          || !requestOriginAllowed(request, config)
          || request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const identity = await authenticateRequest(request, config, oidcVerifier);
        const input = await readJsonBody(request);
        const authorization = await broadcastRuntime.authorizePublisher(identity, input);
        if (authorization.program.programId !== broadcastPublisherAuthorizationMatch[1]) {
          throw new BroadcastRuntimeError("broadcast_not_available", 404);
        }
        const { action, ...publicAuthorization } = authorization;
        sendJson(response, 201, {
          ...publicAuthorization,
          ...(action === "whip:create" ? {
            resourceUrl: `${config.broadcastWhipResourceBase}/${authorization.resourceRef}/whip`,
          } : {}),
        }, securityHeaders(config));
        return;
      }
      const broadcastPlaybackChallengeMatch = url.pathname.match(
        /^\/api\/broadcasts\/(prg_[A-Za-z0-9_-]{16,64})\/playback-challenges$/,
      );
      const broadcastNativeAssignmentMatch = url.pathname.match(
        /^\/api\/broadcasts\/(prg_[A-Za-z0-9_-]{16,64})\/native-assignments$/,
      );
      if (broadcastNativeAssignmentMatch) {
        if (!broadcastRuntime || !config.nativePackagerSelfServiceEnabled
          || request.method !== "POST" || url.search || !requestOriginAllowed(request, config)
          || request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const identity = await authenticateRequest(request, config, oidcVerifier);
        const ownerPrincipal = principalFor(identity);
        const input = await readJsonBody(request);
        assertAllowedKeys(input, new Set([
          "requestVersion", "trigger", "packagerId", "sourceIds", "requestedRenditions",
          "allowHardwareAcceleration", "deviceFingerprint",
        ]));
        if (!/^[A-Za-z0-9_-]{43}$/.test(input.deviceFingerprint || "")) {
          throw new BroadcastRuntimeError("invalid_broadcast_device_fingerprint");
        }
        const activeMember = registry.membersForPrincipal(ownerPrincipal)
          .find((candidate) => candidate.deviceFingerprint === input.deviceFingerprint);
        const preparedProgram = broadcastRuntime.prepareNativePublisher(
          identity,
          activeMember,
          broadcastNativeAssignmentMatch[1],
          {
            requestVersion: input.requestVersion,
            trigger: input.trigger,
            packagerId: input.packagerId,
            sourceIds: input.sourceIds,
            requestedRenditions: input.requestedRenditions,
            allowHardwareAcceleration: input.allowHardwareAcceleration,
          },
          (admissionRequest) => nativePackagerAssignments.admit(
            ownerPrincipal,
            input.packagerId,
            admissionRequest,
          ),
        );
        let assignment;
        try {
          assignment = nativePackagerAssignments.prepare(
            ownerPrincipal,
            input.packagerId,
            preparedProgram.admission,
            preparedProgram.lease,
            activeMember.id,
          );
          if (!safeSend(nativePackagers.socketFor(input.packagerId), assignment.command)) {
            throw new NativePackagerAssignmentError("native_packager_offline", 503);
          }
        } catch (error) {
          nativePackagerAssignments.failPackager(input.packagerId, "ASSIGNMENT_DELIVERY_FAILED");
          broadcastRuntime.stopProgram(identity, broadcastNativeAssignmentMatch[1]);
          throw error;
        }
        sendJson(response, 201, {
          assignment: assignment.snapshot,
          program: preparedProgram.program,
          ownerSubjectRef: broadcastSubjectRef(identity),
        }, securityHeaders(config));
        return;
      }
      if (broadcastPlaybackChallengeMatch) {
        if (!broadcastRuntime || request.method !== "POST" || url.search
          || !requestOriginAllowed(request, config)
          || request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const input = await readJsonBody(request);
        assertAllowedKeys(input, new Set(["requestVersion"]));
        if (input.requestVersion !== 1) throw new BroadcastRuntimeError("invalid_broadcast_playback_challenge");
        const identity = await authenticateRequest(request, config, oidcVerifier);
        const challenge = await broadcastRuntime.createPlaybackChallenge(
          identity,
          broadcastPlaybackChallengeMatch[1],
        );
        sendJson(response, 201, challenge, securityHeaders(config));
        return;
      }
      const broadcastPlaybackMatch = url.pathname.match(
        /^\/api\/broadcasts\/(prg_[A-Za-z0-9_-]{16,64})\/playback$/,
      );
      if (broadcastPlaybackMatch) {
        if (!broadcastRuntime || request.method !== "POST" || url.search
          || !requestOriginAllowed(request, config)
          || request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const identity = await authenticateRequest(request, config, oidcVerifier);
        const input = await readJsonBody(request);
        const bootstrap = await broadcastRuntime.authorizePlayback(identity, input);
        if (bootstrap.program.programId !== broadcastPlaybackMatch[1]) {
          throw new BroadcastRuntimeError("broadcast_not_available", 404);
        }
        sendJson(response, 201, bootstrap, securityHeaders(config));
        return;
      }
      const broadcastProgramMatch = url.pathname.match(
        /^\/api\/broadcasts\/(prg_[A-Za-z0-9_-]{16,64})$/,
      );
      if (broadcastProgramMatch && request.method === "PATCH") {
        if (!broadcastRuntime || url.search || !requestOriginAllowed(request, config)
          || request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const identity = await authenticateRequest(request, config, oidcVerifier);
        const updated = broadcastRuntime.changeVisibility(
          identity,
          broadcastProgramMatch[1],
          await readJsonBody(request),
        );
        sendJson(response, 200, { program: updated }, securityHeaders(config));
        return;
      }
      if (broadcastProgramMatch && request.method === "DELETE") {
        if (!broadcastRuntime || url.search || !requestOriginAllowed(request, config)) {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const identity = await authenticateRequest(request, config, oidcVerifier);
        const activeAssignment = nativePackagerAssignments.activeForProgram(broadcastProgramMatch[1]);
        if (activeAssignment) {
          const stoppedAssignment = nativePackagerAssignments.stop(
            principalFor(identity), activeAssignment.packagerId, activeAssignment.assignmentId, "OWNER_STOP",
          );
          if (stoppedAssignment.command) {
            safeSend(nativePackagers.socketFor(activeAssignment.packagerId), stoppedAssignment.command);
          }
        }
        const stopped = broadcastRuntime.stopProgram(identity, broadcastProgramMatch[1]);
        sendJson(response, 200, { program: stopped }, securityHeaders(config));
        return;
      }
      if (url.pathname.startsWith("/api/broadcasts/")) {
        response.writeHead(404, { "cache-control": "no-store" });
        response.end();
        return;
      }
      if (url.pathname === "/api/broadcast/playback-sessions") {
        if (!broadcastHlsProxy) {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405, { allow: "POST", "cache-control": "no-store" });
          response.end();
          return;
        }
        const origin = request.headers.origin || "";
        if (url.search || origin !== config.publicOrigin
          || request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        if (broadcastAbuseGuard && !broadcastAbuseGuard.allow({
          action: "credential-attempt", actorRef: request.socket.remoteAddress || "unknown-address",
        })) {
          sendJson(response, 429, { error: "broadcast_temporarily_unavailable" }, {
            "retry-after": "60", ...securityHeaders(config),
          });
          return;
        }
        const input = await readJsonBody(request);
        assertAllowedKeys(input, new Set(["resourceRef"]));
        const session = await broadcastHlsProxy.createSession({
          authorizationHeader: request.headers.authorization || "",
          resourceRef: input.resourceRef,
          origin,
        });
        sendJson(response, 201, {
          playbackSessionId: session.playbackSessionId,
          manifestUrl: session.manifestUrl,
          expiresAt: session.expiresAt,
        }, { "set-cookie": session.setCookie, ...securityHeaders(config) });
        return;
      }
      const playbackSessionMatch = url.pathname.match(/^\/api\/broadcast\/playback-sessions\/(pbs_[A-Za-z0-9_-]{24,64})$/);
      if (playbackSessionMatch) {
        if (!broadcastHlsProxy) {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        if (request.method !== "DELETE") {
          response.writeHead(405, { allow: "DELETE", "cache-control": "no-store" });
          response.end();
          return;
        }
        const expiredCookie = broadcastHlsProxy.closeSession({
          sessionId: playbackSessionMatch[1],
          cookieHeader: request.headers.cookie || "",
          origin: request.headers.origin || "",
        });
        response.writeHead(204, { "cache-control": "no-store", "set-cookie": expiredCookie, ...securityHeaders(config) });
        response.end();
        return;
      }
      const broadcastMediaMatch = url.pathname.match(/^\/broadcast\/play\/(res_[A-Za-z0-9_-]{16,64})\/([^/]{1,128})$/);
      if (broadcastMediaMatch) {
        if (!broadcastHlsProxy) {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        if (broadcastAbuseGuard && !broadcastAbuseGuard.allow({
          action: "playback-probe", actorRef: request.socket.remoteAddress || "unknown-address",
        })) {
          sendJson(response, 429, { error: "broadcast_temporarily_unavailable" }, {
            "retry-after": "60", ...securityHeaders(config),
          });
          return;
        }
        const result = await broadcastHlsProxy.fetchMedia({
          cookieHeader: request.headers.cookie || "",
          method: request.method || "",
          resourceRef: broadcastMediaMatch[1],
          file: broadcastMediaMatch[2],
          query: url.search,
          origin: request.headers.origin || "",
          range: request.headers.range || "",
        });
        response.writeHead(result.status, { ...result.headers, ...securityHeaders(config) });
        if (!result.body || request.method === "HEAD") response.end();
        else await pipeline(Readable.fromWeb(result.body), response);
        return;
      }
      if (url.pathname === "/internal/broadcast/mediamtx-auth") {
        if (!config.broadcastGatewayAuthEnabled || !mediaMtxExternalAuthService) {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405, { allow: "POST", "cache-control": "no-store" });
          response.end();
          return;
        }
        const remoteAddress = request.socket.remoteAddress || "";
        if (request.headers.origin || url.search
          || !config.broadcastGatewayAuthAddresses.includes(remoteAddress)
          || request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          response.writeHead(404, { "cache-control": "no-store" });
          response.end();
          return;
        }
        if (broadcastAbuseGuard && !broadcastAbuseGuard.allow({
          action: "credential-attempt", actorRef: request.socket.remoteAddress || "unknown-address",
        })) {
          response.writeHead(429, { "cache-control": "no-store", "retry-after": "60" });
          response.end();
          return;
        }
        const input = await readJsonBody(request);
        await mediaMtxExternalAuthService.authorize(input);
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }
      const artifactMatch = url.pathname.match(/^\/downloads\/media-edge-agent\/([a-z0-9-]+)$/);
      if (artifactMatch && request.method === "GET") {
        if (!config.mediaAgentSelfServiceEnabled || !mediaAgentInstallerService) {
          throw new MediaAgentInstallerError("media_agent_artifact_unavailable", 404);
        }
        const artifact = mediaAgentInstallerService.artifact(artifactMatch[1]);
        const file = await fs.open(artifact.filename, "r");
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== artifact.size) {
          await file.close();
          throw new MediaAgentInstallerError("media_agent_artifact_unavailable", 503);
        }
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": artifact.size,
          "content-disposition": `attachment; filename="${artifact.artifact}"`,
          "cache-control": "public, max-age=300, immutable",
          "x-content-sha256": artifact.sha256,
          ...securityHeaders(config),
        });
        const stream = file.createReadStream();
        stream.on("error", () => response.destroy());
        stream.pipe(response);
        return;
      }
      if (url.pathname === "/api/media-agents" && request.method === "GET") {
        if ((!config.mediaAgentSelfServiceEnabled || !mediaAgentEnrollmentStore) && !mediaAgents.configured) {
          throw new MediaAgentEnrollmentError("media_agent_self_service_disabled", 404);
        }
        const identity = await authenticateRequest(request, config, oidcVerifier);
        if (!identity) throw new AuthenticationError("authentication_required");
        const principal = principalFor(identity);
        const agents = mediaAgentEnrollmentStore ? mediaAgentEnrollmentStore.list(principal) : [];
        const selfServiceIds = new Set(agents.map(({ id }) => id));
        sendJson(response, 200, {
          agents: agents.map((agent) => ({
            ...agent,
            online: !agent.revokedAt && Boolean(mediaAgents.socketForAgent(agent.id)),
          })),
          operatorAgents: mediaAgents.configuredForPrincipal(principal)
            .filter(({ id }) => !selfServiceIds.has(id)),
        }, securityHeaders(config));
        return;
      }
      if (url.pathname === "/api/media-agents/enrollments" && request.method === "POST") {
        if (!config.mediaAgentSelfServiceEnabled || !mediaAgentEnrollmentStore || !mediaAgentInstallerService) {
          throw new MediaAgentEnrollmentError("media_agent_self_service_disabled", 404);
        }
        if (!requestOriginAllowed(request, config)) throw new ProtocolError("origin_denied");
        const identity = await authenticateRequest(request, config, oidcVerifier);
        if (!identity) throw new AuthenticationError("authentication_required");
        const input = await readJsonBody(request);
        assertAllowedKeys(input, MEDIA_AGENT_ENROLLMENT_FIELDS);
        const target = mediaAgentInstallerService.target(input.target);
        const enrollment = mediaAgentEnrollmentStore.createEnrollment({
          principal: principalFor(identity),
          label: input.label,
          platform: target.platform,
        });
        const installer = mediaAgentInstallerService.installer({
          enrollment,
          targetId: target.id,
          publicOrigin: config.publicOrigin,
        });
        sendJson(response, 201, {
          agentId: enrollment.agentId,
          expiresAt: enrollment.expiresAt,
          target: installer.target,
          filename: installer.filename,
          artifactSha256: installer.artifactSha256,
          artifactBytes: installer.artifactBytes,
          installer: installer.content,
        }, securityHeaders(config));
        return;
      }
      const mediaAgentMatch = url.pathname.match(/^\/api\/media-agents\/(edge-[a-f0-9]{16})$/);
      if (mediaAgentMatch && request.method === "DELETE") {
        if (!config.mediaAgentSelfServiceEnabled || !mediaAgentEnrollmentStore) {
          throw new MediaAgentEnrollmentError("media_agent_self_service_disabled", 404);
        }
        if (!requestOriginAllowed(request, config)) throw new ProtocolError("origin_denied");
        const identity = await authenticateRequest(request, config, oidcVerifier);
        if (!identity) throw new AuthenticationError("authentication_required");
        const revoked = mediaAgentEnrollmentStore.revoke(principalFor(identity), mediaAgentMatch[1]);
        const removed = mediaAgents.revoke(revoked.agentId);
        removed.socket?.close(1008, "agent_registration_revoked");
        mediaAgentEvents.onRevoked(removed);
        sendJson(response, 200, revoked, securityHeaders(config));
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

function configureSignaling(
  server,
  config,
  registry,
  ticketStore,
  directory,
  mediaAgents,
  mediaAgentEvents,
  broadcastRuntime,
  nativePackagers,
  nativePackagerAssignments,
) {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024 });
  const mediaAgentWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024 });
  const nativePackagerWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const roomEpochs = new Map();
  const mediaAgentTracks = new Map();
  const mediaAgentTrackRouteEpochs = new Map();
  const relayHealth = new RelayHealthTracker({
    windowMs: config.peerRelayHealthWindowMs,
    cooldownMs: config.peerRelayHealthCooldownMs,
  });

  const iceServersForAgent = (agentId) => createMediaAgentIceServers(config, agentId);

  let agentSyncTimer = null;
  const sendAgentSync = () => {
    for (const agentId of mediaAgents.connectedAgentIds()) {
      safeSend(mediaAgents.socketForAgent(agentId), {
        version: 1,
        type: "agent-sync",
        leases: mediaAgents.roomLeases(
          agentId,
          (roomId) => registry.members(roomId),
          iceServersForAgent,
        ),
      }, MAX_MEDIA_AGENT_SYNC_BYTES);
    }
  };
  const syncAgents = () => {
    if (agentSyncTimer) clearTimeout(agentSyncTimer);
    agentSyncTimer = null;
    sendAgentSync();
  };
  const scheduleAgentSync = () => {
    if (agentSyncTimer) return;
    agentSyncTimer = setTimeout(() => {
      agentSyncTimer = null;
      sendAgentSync();
    }, 50);
    agentSyncTimer.unref?.();
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

  mediaAgentEvents.onRevoked = ({ affectedRoomIds, ownerPrincipal }) => {
    broadcastPrincipalMediaAgentAvailability(ownerPrincipal);
    for (const roomId of affectedRoomIds) broadcastMediaAgentState(roomId);
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
      enabled: config.peerMediaRelayEnabled && config.mediaE2eeMode === "disabled",
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
      if (!mediaAgents.configured && !mediaAgents.enrollmentEnabled) {
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
    if (url.pathname === "/native-packager") {
      if (!nativePackagers.configured && !nativePackagers.enrollmentEnabled) {
        rejectUpgrade(socket, 403, "native_packagers_disabled");
        return;
      }
      if (request.headers.origin || url.search || url.hash) {
        rejectUpgrade(socket, 403, "native_packager_origin_denied");
        return;
      }
      nativePackagerWebSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        nativePackagerWebSocketServer.emit("connection", webSocket, request);
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
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      try {
        broadcastRuntime?.stopProgramsForMember?.(peer);
      } catch {
        // Broadcast teardown is independently lease-bounded and must never retain
        // the participant in the room when its optional runtime is unhealthy.
      }
      relayHealth.leave(peer.roomId, peer.id);
      mediaAgents.leavePeer(peer);
      for (const recipient of registry.leave(peer)) {
        safeSend(recipient.socket, { type: "peer-left", peerId: peer.id });
      }
      directory.touch(peer.roomId);
      broadcastTopology(peer.roomId, true);
    };
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
        if (message.type === "leave") {
          leave();
          socket.close(1000, "client_leave");
          return;
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
        if (message.type === "native-packager-signal") {
          nativePackagerAssignments.authorizeBrowserSignal(peer, message);
          const packagerSocket = nativePackagers.socketFor(message.packagerId);
          if (!packagerSocket) throw new ProtocolError("native_packager_unavailable");
          safeSend(packagerSocket, {
            version: 1,
            type: "assignment-peer-signal",
            assignmentId: message.assignmentId,
            publisherPeerId: peer.id,
            programEpoch: message.programEpoch,
            fencingRevision: message.fencingRevision,
            ...(message.description ? { description: message.description } : { candidate: message.candidate }),
          });
          return;
        }
        if (message.type === "media-state") {
          registry.setMediaState(peer, message);
          if (!message.active && mediaAgents.removePublisherSource(peer.roomId, peer.id, message.source)) {
            syncAgents();
          }
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
        if (message.type === "media-agent-consent-set") {
          mediaAgents.setConsentSet(
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
            || !mediaAgents.authorizePeerAgent(peer.roomId, message.agentId, message.routeEpoch, peer.id)) {
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
        if (message.type === "media-agent-subscription-intent") {
          const publication = registry.publication(
            message.publisherPeerId, message.publicationId, message.roomId,
          );
          if (!publication) throw new ProtocolError("agent_publication_unauthorized");
          const plan = mediaAgents.setSubscriptionIntent(peer, message, publication);
          const publisher = registry.members(peer.roomId)
            .find((member) => member.id === message.publisherPeerId);
          if (!publisher) throw new ProtocolError("recipient_unavailable");
          const pendingState = {
            version: 2,
            type: "media-agent-subscription-state",
            agentId: message.agentId,
            routeEpoch: message.routeEpoch,
            publicationId: message.publicationId,
            subscriberPeerId: peer.id,
            selectedLayer: plan.preferredLayer,
            revision: plan.revision,
            ready: false,
          };
          safeSend(publisher.socket, pendingState);
          safeSend(peer.socket, pendingState);
          scheduleAgentSync();
          return;
        }
        if (message.type === "media-agent-subscription-ack") {
          const applied = mediaAgents.acknowledgeSubscription(peer, message);
          const publisher = registry.members(peer.roomId)
            .find((member) => member.id === message.publisherPeerId);
          if (!publisher) throw new ProtocolError("recipient_unavailable");
          safeSend(publisher.socket, {
            version: 2,
            type: "media-agent-subscription-state",
            agentId: message.agentId,
            routeEpoch: message.routeEpoch,
            publicationId: message.publicationId,
            subscriberPeerId: peer.id,
            selectedLayer: applied.selectedLayer,
            revision: applied.revision,
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
          if (message.type === "enroll") {
            const result = mediaAgents.enroll(socket, message);
            clearTimeout(authTimeout);
            safeSend(socket, {
              version: 1,
              type: "agent-enrolled",
              agentId: result.id,
              keyFingerprint: result.keyFingerprint,
            });
            broadcastPrincipalMediaAgentAvailability(result.ownerPrincipal);
            setImmediate(() => socket.close(1000, "agent_enrolled"));
            return;
          }
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
        if (message.type === "authenticate" || message.type === "enroll") {
          throw new ProtocolError("agent_already_authenticated");
        }
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
          if (!mediaAgents.authorizePeerAgent(message.roomId, connection.id, message.routeEpoch, message.peerId)) {
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
        if (message.type === "federation-signal") {
          const link = mediaAgents.federationLink(
            message.roomId,
            message.routeEpoch,
            message.linkId,
            connection.id,
            message.recipientAgentId,
          );
          if (!link) throw new ProtocolError("stale_federation_link");
          const recipient = mediaAgents.socketForAgent(message.recipientAgentId);
          if (!recipient) throw new ProtocolError("media_agent_unavailable");
          safeSend(recipient, {
            ...message,
            version: 1,
            type: "federation-peer-signal",
            fromAgentId: connection.id,
            recipientAgentId: undefined,
          });
          return;
        }
        if (message.type === "federation-state") {
          mediaAgents.setFederationState(
            socket,
            message.roomId,
            message.routeEpoch,
            message.linkId,
            message.remoteAgentId,
            message.connected,
          );
          broadcastMediaAgentState(message.roomId);
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
          const trackKey = `${message.roomId}\0${connection.id}\0${message.peerId}\0${message.publicationId}\0${message.layer}`;
          const publication = registry.publication(message.peerId, message.publicationId, message.roomId);
          const source = publication?.source || mediaAgentTracks.get(trackKey);
          if (message.active && !publication) {
            throw new ProtocolError("agent_publication_unauthorized");
          }
          if (!source) throw new ProtocolError("agent_publication_unauthorized");
          const validLayer = (source === "camera"
            && new Set(["single", "low", "medium", "high"]).has(message.layer)
            && ((message.layer === "single" && message.rid === "")
              || ({ low: "q", medium: "h", high: "f" })[message.layer] === message.rid))
            || (source === "screen" && message.layer === "single" && message.rid === "")
            || (new Set(["microphone", "screen-audio"]).has(source)
              && message.layer === "audio" && message.rid === "");
          if (!validLayer) throw new ProtocolError("invalid_agent_publication_layer");
          if (message.active) mediaAgentTracks.set(trackKey, source);
          else mediaAgentTracks.delete(trackKey);
          const layerChanged = mediaAgents.setPublicationLayerState(
            message.roomId,
            connection.id,
            message.routeEpoch,
            message.peerId,
            message.publicationId,
            source,
            message.layer,
            message.active,
          );
          for (const recipient of registry.members(message.roomId)) {
            safeSend(recipient.socket, {
              version: 2,
              type: "media-agent-track-state",
              agentId: connection.id,
              routeEpoch: message.routeEpoch,
              peerId: message.peerId,
              publicationId: message.publicationId,
              source,
              layer: message.layer,
              rid: message.rid,
              active: message.active,
            });
          }
          if (layerChanged) scheduleAgentSync();
          return;
        }
        if (message.type === "subscription-state") {
          const plan = mediaAgents.subscriptionPlan(
            message.roomId,
            connection.id,
            message.routeEpoch,
            message.subscriberPeerId,
            message.publisherPeerId,
            message.publicationId,
          );
          const layerRank = { low: 0, medium: 1, high: 2 };
          const selectedAllowed = plan && (plan.maximumLayer === "audio" || plan.maximumLayer === "single"
            ? message.selectedLayer === plan.maximumLayer
            : message.selectedLayer === "single" || Object.hasOwn(layerRank, message.selectedLayer)
              && layerRank[message.selectedLayer] <= layerRank[plan.preferredLayer]
              && layerRank[message.selectedLayer] <= layerRank[plan.maximumLayer]);
          if (!plan || (message.ready && (!plan.enabled || !selectedAllowed))) {
            throw new ProtocolError("stale_agent_subscription");
          }
          const applied = mediaAgents.setAgentSubscriptionState(
            message.roomId,
            connection.id,
            message.routeEpoch,
            message.subscriberPeerId,
            message.publisherPeerId,
            message.publicationId,
            message.revision,
            message.selectedLayer,
            message.ready,
          );
          const members = registry.members(message.roomId);
          const subscriber = members.find((member) => member.id === message.subscriberPeerId);
          if (!subscriber) throw new ProtocolError("recipient_unavailable");
          const publisher = members.find((member) => member.id === message.publisherPeerId);
          if (!publisher) throw new ProtocolError("recipient_unavailable");
          safeSend(subscriber.socket, {
            version: 2,
            type: "media-agent-subscription-state",
            agentId: connection.id,
            routeEpoch: message.routeEpoch,
            publicationId: message.publicationId,
            subscriberPeerId: message.subscriberPeerId,
            selectedLayer: applied.selectedLayer,
            revision: applied.revision,
            ready: message.ready,
          });
          if (!message.ready) {
            safeSend(publisher.socket, {
              version: 2,
              type: "media-agent-subscription-state",
              agentId: connection.id,
              routeEpoch: message.routeEpoch,
              publicationId: message.publicationId,
              subscriberPeerId: message.subscriberPeerId,
              selectedLayer: applied.selectedLayer,
              revision: applied.revision,
              ready: false,
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

  nativePackagerWebSocketServer.on("connection", (socket) => {
    socket.isAlive = true;
    let authenticated = false;
    safeSend(socket, nativePackagers.issueChallenge(socket));
    const timeout = setTimeout(() => {
      if (!authenticated) socket.close(1008, "native_packager_authentication_timeout");
    }, 31_000);
    timeout.unref();
    socket.on("pong", () => { socket.isAlive = true; });
    socket.on("message", (raw, isBinary) => {
      try {
        if (isBinary) throw new NativePackagerControlError("binary_native_packager_control_unsupported");
        const message = parseNativePackagerMessage(raw);
        if (!authenticated) {
          if (message.type === "enroll") {
            const result = nativePackagers.enroll(socket, message);
            clearTimeout(timeout);
            safeSend(socket, { version: 1, type: "packager-enrolled", packagerId: result.id,
              keyFingerprint: result.keyFingerprint });
            setImmediate(() => socket.close(1000, "native_packager_enrolled"));
            return;
          }
          if (message.type !== "authenticate") {
            throw new NativePackagerControlError("native_packager_authentication_required", 403);
          }
          const result = nativePackagers.authenticate(socket, message);
          authenticated = true;
          clearTimeout(timeout);
          result.replacedSocket?.close(1008, "native_packager_connection_replaced");
          safeSend(socket, { version: 1, type: "packager-authenticated", packagerId: result.id });
          safeSend(socket, nativePackagers.consentState(result.id));
          return;
        }
        const connection = nativePackagers.connection(socket);
        if (!connection || message.type === "authenticate" || message.type === "enroll") {
          throw new NativePackagerControlError("native_packager_already_authenticated", 403);
        }
        if (!nativePackagers.allowMessage(socket)) {
          throw new NativePackagerControlError("native_packager_rate_limited", 429);
        }
        if (message.type === "capability") {
          const separator = connection.ownerPrincipal.lastIndexOf("|");
          const identity = {
            issuer: connection.ownerPrincipal.slice(0, separator),
            subject: connection.ownerPrincipal.slice(separator + 1),
          };
          nativePackagers.setCapability(socket, message.capability, {
            tenantId: broadcastTenantRef(identity.issuer),
            ownerSubjectRef: broadcastSubjectRef(identity),
          });
          safeSend(socket, { version: 1, type: "capability-accepted", observedAt: Date.now() });
          return;
        }
        if (message.type === "heartbeat") {
          nativePackagers.heartbeat(socket, message);
          return;
        }
        if (message.type === "assignment-status") {
          nativePackagerAssignments.acknowledge(connection.id, message);
          return;
        }
        if (message.type === "assignment-signal") {
          const assignment = nativePackagerAssignments.authorizePackagerSignal(connection.id, message);
          const publisher = registry.members(assignment.roomId)
            .find((candidate) => candidate.id === assignment.publisherPeerId);
          if (!publisher) throw new NativePackagerAssignmentError("native_packager_publisher_unavailable", 409);
          safeSend(publisher.socket, {
            version: 1,
            type: "native-packager-signal",
            packagerId: assignment.packagerId,
            assignmentId: assignment.assignmentId,
            programId: assignment.programId,
            programEpoch: assignment.programEpoch,
            fencingRevision: assignment.fencingRevision,
            ...(message.description ? { description: message.description } : { candidate: message.candidate }),
          });
          return;
        }
        throw new NativePackagerControlError("unknown_native_packager_message");
      } catch (error) {
        const code = error instanceof NativePackagerControlError || error instanceof NativePackagerAssignmentError
          ? error.code : "invalid_native_packager_message";
        safeSend(socket, { version: 1, type: "packager-error", code });
        socket.close(1008, code);
      }
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      const connection = nativePackagers.connection(socket);
      nativePackagers.disconnect(socket);
      if (connection) {
        const failedAssignment = nativePackagerAssignments.failPackager(connection.id);
        if (failedAssignment) stopProgramForPrincipal(
          broadcastRuntime, connection.ownerPrincipal, failedAssignment.programId,
        );
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of [
      ...webSocketServer.clients,
      ...mediaAgentWebSocketServer.clients,
      ...nativePackagerWebSocketServer.clients,
    ]) {
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
    mediaAgentEvents.prune();
    nativePackagerAssignments.prune(Date.now(), (ownerPrincipal, expiredAssignment, stopCommand) => {
      safeSend(nativePackagers.socketFor(expiredAssignment.packagerId), stopCommand);
      stopProgramForPrincipal(broadcastRuntime, ownerPrincipal, expiredAssignment.programId);
    });
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
    for (const socket of nativePackagerWebSocketServer.clients) socket.terminate();
  });
  return { webSocketServer, mediaAgentWebSocketServer, nativePackagerWebSocketServer };
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
  const mediaAgentEnrollmentStore = options.mediaAgentEnrollmentStore
    || (config.mediaAgentSelfServiceEnabled ? new MediaAgentEnrollmentStore({
      filename: config.mediaAgentRegistrationDb,
      ttlMs: config.mediaAgentEnrollmentTtlMs,
      maxAgentsPerPrincipal: config.mediaAgentMaxPerPrincipal,
      maxEnrollmentsPerHour: config.mediaAgentEnrollmentRateLimit,
    }) : null);
  const mediaAgentInstallerService = options.mediaAgentInstallerService
    || (config.mediaAgentSelfServiceEnabled
      ? new MediaAgentInstallerService({ directory: config.mediaAgentArtifactDir }) : null);
  const mediaAgents = options.mediaAgents || new MediaAgentRegistry({
    definitions: [...config.mediaAgents, ...(mediaAgentEnrollmentStore?.definitions() || [])],
    leaseMs: config.mediaAgentLeaseMs,
    maxStandbys: config.mediaAgentMaxStandbys,
    minimumParticipants: config.mediaAgentMinParticipants,
    shardMinParticipants: config.mediaAgentShardMinParticipants,
    takeoverTtlMs: config.mediaAgentTakeoverTtlMs,
    enrollmentStore: mediaAgentEnrollmentStore,
  });
  const nativePackagerEnrollmentStore = options.nativePackagerEnrollmentStore
    || (config.nativePackagerSelfServiceEnabled ? new NativePackagerEnrollmentStore({
      filename: config.nativePackagerRegistrationDb,
      ttlMs: config.nativePackagerEnrollmentTtlMs,
      maximumPerPrincipal: config.nativePackagerMaxPerPrincipal,
    }) : null);
  const nativePackagerInstallerService = options.nativePackagerInstallerService
    || (config.nativePackagerSelfServiceEnabled
      ? new NativePackagerInstallerService({ directory: config.nativePackagerArtifactDir }) : null);
  const nativePackagers = options.nativePackagers || new NativePackagerControlRegistry({
    enrollmentStore: nativePackagerEnrollmentStore,
    definitions: nativePackagerEnrollmentStore?.definitions() || [],
  });
  const nativePackagerAssignments = options.nativePackagerAssignments
    || new NativePackagerAssignmentRegistry({ controlRegistry: nativePackagers });
  const workspaceStore = options.workspaceStore || (config.pairWorkspaceEnabled
    ? new PairWorkspaceStore({ filename: config.pairWorkspaceDb }) : null);
  const publicDir = path.resolve(options.publicDir || DEFAULT_PUBLIC_DIR);
  const mediaAgentEvents = {
    onRevoked: () => {},
    prune: () => mediaAgentEnrollmentStore?.prune(),
  };
  let broadcastGrantAuthority = options.broadcastGrantAuthority || null;
  if (config.broadcastWhipEndpoint && !broadcastGrantAuthority && !options.broadcastRuntime) {
    if (config.authMode !== "required" || !config.publicOrigin
      || new URL(config.publicOrigin).protocol !== "https:"
      || !config.broadcastGatewayAuthEnabled || !config.broadcastGatewayOrigin
      || !config.broadcastSigningPrivateKey || !config.broadcastWhipResourceBase) {
      throw new Error(
        "BROADCAST_WHIP_ENDPOINT requires required OIDC, HTTPS PUBLIC_ORIGIN, gateway auth/origin, resource base and a signing private key",
      );
    }
    let privateKey;
    try { privateKey = crypto.createPrivateKey(config.broadcastSigningPrivateKey); } catch {
      throw new Error("BROADCAST_SIGNING_PRIVATE_KEY is not a valid private key");
    }
    if (privateKey.asymmetricKeyType !== "ec"
      || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("BROADCAST_SIGNING_PRIVATE_KEY must be a P-256 private key");
    }
    broadcastGrantAuthority = new BroadcastGrantAuthority({
      issuer: `${config.publicOrigin}/broadcast-grants`,
      oidcIssuer: config.oidcIssuer,
      oidcAudience: config.oidcAudience,
      oidcAlgorithms: config.oidcAlgorithms,
      signingKeys: [{
        kid: config.broadcastSigningKeyId,
        privateKey,
        publicKey: crypto.createPublicKey(privateKey),
      }],
    });
  }
  const broadcastRuntime = options.broadcastRuntime || (broadcastGrantAuthority
    ? new BroadcastRuntimeRegistry({ grantAuthority: broadcastGrantAuthority }) : null);
  const mediaMtxExternalAuthService = options.mediaMtxExternalAuthService
    || (broadcastGrantAuthority && config.broadcastGatewayAuthEnabled
      ? new MediaMtxExternalAuthService({
        authority: broadcastGrantAuthority,
        onAuthorized: ({ request, now }) => {
          if (request.action === "publish") broadcastRuntime.markPublished(request.path, now);
        },
      }) : null);
  const broadcastPlaybackSessions = options.broadcastPlaybackSessions
    || (broadcastGrantAuthority && config.broadcastGatewayOrigin
      ? new BroadcastPlaybackSessionStore({
        authority: broadcastGrantAuthority,
        publicOrigin: config.publicOrigin,
      }) : null);
  const broadcastHlsProxy = options.broadcastHlsProxy
    || (broadcastPlaybackSessions && config.broadcastGatewayOrigin
      ? new BroadcastHlsProxy({
        sessions: broadcastPlaybackSessions,
        gatewayOrigin: config.broadcastGatewayOrigin,
      }) : null);
  const ownsBroadcastAbuseGuard = !options.broadcastAbuseGuard && Boolean(broadcastHlsProxy || mediaMtxExternalAuthService);
  const broadcastAbuseGuard = options.broadcastAbuseGuard || (ownsBroadcastAbuseGuard
    ? new BroadcastAbuseGuard({ key: crypto.randomBytes(32) }) : null);
  const broadcastHealthRegistry = options.broadcastHealthRegistry || new BroadcastHealthRegistry();
  if (config.broadcastGatewayAuthEnabled && !mediaMtxExternalAuthService) {
    throw new Error("BROADCAST_GATEWAY_AUTH_ENABLED requires a MediaMTX external auth service");
  }
  const services = {
    oidcVerifier,
    deviceProofVerifier,
    ticketStore,
    workspaceStore,
    directory,
    publicDir,
    mediaAgents,
    mediaAgentEnrollmentStore,
    mediaAgentInstallerService,
    mediaAgentEvents,
    nativePackagers,
    nativePackagerEnrollmentStore,
    nativePackagerInstallerService,
    nativePackagerAssignments,
    mediaMtxExternalAuthService,
    broadcastHlsProxy,
    broadcastAbuseGuard,
    broadcastHealthRegistry,
    broadcastRuntime,
    broadcastGrantAuthority,
    broadcastPlaybackSessions,
  };
  const server = http.createServer(createHttpHandler(config, registry, services));
  if (!options.workspaceStore && workspaceStore) server.on("close", () => workspaceStore.close());
  if (!options.mediaAgentEnrollmentStore && mediaAgentEnrollmentStore) {
    server.on("close", () => mediaAgentEnrollmentStore.close());
  }
  if (!options.nativePackagerEnrollmentStore && nativePackagerEnrollmentStore) {
    server.on("close", () => nativePackagerEnrollmentStore.close());
  }
  if (ownsBroadcastAbuseGuard) server.on("close", () => broadcastAbuseGuard.destroy());
  const signaling = configureSignaling(
    server, config, registry, ticketStore, directory, mediaAgents, mediaAgentEvents, broadcastRuntime,
    nativePackagers, nativePackagerAssignments,
  );
  return {
    server,
    ...signaling,
    config,
    registry,
    directory,
    ticketStore,
    workspaceStore,
    mediaAgents,
    mediaAgentEnrollmentStore,
    mediaAgentInstallerService,
    nativePackagers,
    nativePackagerEnrollmentStore,
    nativePackagerInstallerService,
    nativePackagerAssignments,
    broadcastAbuseGuard,
    broadcastHealthRegistry,
    broadcastRuntime,
    broadcastGrantAuthority,
    broadcastPlaybackSessions,
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
