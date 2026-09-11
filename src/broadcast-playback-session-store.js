import crypto from "node:crypto";
import { BroadcastPlaybackCapacity, normalizeBroadcastPlaybackCapacity, playbackCapacityScope, playbackProgramScope } from "./broadcast-playback-capacity.js";

const RESOURCE = /^res_[A-Za-z0-9_-]{16,64}$/;
const SESSION = /^pbs_[A-Za-z0-9_-]{24,64}$/;
const COOKIE_NAME = /^__Secure-webrtc-broadcast-[A-Za-z0-9_-]{8,16}$/;
const MEDIA_FILE = /^(?:[A-Za-z0-9_-]{1,96}\.(?:m3u8|mp4|m4s|vtt|key)|gap\.mp4|(?:low|medium|high)\/(?:index\.m3u8|init(?:_[0-2])?\.mp4|segment_[0-9]{1,12}\.m4s))$/;
const MANIFEST_FILE = /\.m3u8$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class BroadcastPlaybackSessionError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "BroadcastPlaybackSessionError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) { throw new BroadcastPlaybackSessionError(code, status); }
function notFound() { fail("broadcast_playback_not_found", 404); }

// Keep the supplied epoch anchor (also used by deterministic fixtures), but
// never reuse pre-await time after asynchronous authorization has elapsed.
function playbackCheckTime(epoch, clock) {
  const read = () => {
    let value;
    try { value = clock(); } catch { notFound(); }
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) notFound();
    return value;
  };
  if (!Number.isSafeInteger(epoch) || epoch < 0) notFound();
  const start = read();
  let previous = start;
  return () => {
    const current = read();
    if (current < previous) notFound();
    previous = current;
    const now = epoch + Math.ceil(current - start);
    if (!Number.isSafeInteger(now)) notFound();
    return now;
  };
}

function parseQuery(value, manifest) {
  if (typeof value !== "string" || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) notFound();
  const query = new URLSearchParams(value.startsWith("?") ? value.slice(1) : value);
  const allowed = manifest
    ? new Set(["_HLS_msn", "_HLS_part", "_HLS_skip", "session"])
    : new Set(["session"]);
  if ([...query.keys()].some((key) => !allowed.has(key)) || [...query.keys()].length !== new Set(query.keys()).size) notFound();
  for (const [key, item] of query) {
    if ((key === "_HLS_msn" && !/^\d{1,10}$/.test(item))
      || (key === "_HLS_part" && !/^\d{1,4}$/.test(item))
      || (key === "_HLS_skip" && !new Set(["YES", "v2"]).has(item))
      || (key === "session" && !UUID.test(item))) notFound();
  }
  return query.toString();
}

function cookieEntries(header) {
  if (typeof header !== "string" || header.length < 1 || header.length > 8_192) return [];
  return header.split(";").map((item) => item.trim().split("=", 2)).filter(([name, value]) => (
    COOKIE_NAME.test(name || "") && SESSION.test(value || "")
  ));
}

function sameGrantScope(left, right) {
  return [
    "tenantId", "audienceRef", "deviceRef", "roomId", "programId", "programEpoch", "resourceRef",
    "policyId", "policyRevision",
  ].every((field) => left[field] === right[field]);
}

function sessionCookies(session, maxAge) {
  const value = maxAge > 0 ? session.sessionId : "";
  const attributes = `Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
  return Object.freeze([
    `${session.cookieName}=${value}; Path=/broadcast/play/${session.resourceRef}/; ${attributes}`,
    `${session.cookieName}=${value}; Path=/api/broadcast/playback-sessions/${session.sessionId}; ${attributes}`,
  ]);
}

export class BroadcastPlaybackSessionStore {
  #authority;
  #origin;
  #sessions = new Map();
  #idFactory;
  #capacity;
  #clock;

  constructor(options) {
    if (!options?.authority || typeof options.authority.authorizeGatewayBearer !== "function") {
      fail("invalid_broadcast_playback_session_configuration", 500);
    }
    let origin;
    try { origin = new URL(options.publicOrigin); } catch { fail("invalid_broadcast_playback_session_configuration", 500); }
    if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin
      || origin.username || origin.password || origin.search || origin.hash) {
      fail("invalid_broadcast_playback_session_configuration", 500);
    }
    this.#authority = options.authority;
    this.#clock = options.monotonicClock === undefined ? (() => performance.now()) : options.monotonicClock;
    if (typeof this.#clock !== "function") fail("invalid_broadcast_playback_session_configuration", 500);
    this.#origin = origin.origin;
    this.#idFactory = options.idFactory || (() => `pbs_${crypto.randomBytes(24).toString("base64url")}`);
    try {
      this.#capacity = new BroadcastPlaybackCapacity({ ...normalizeBroadcastPlaybackCapacity(options.capacityLimits),
        ...(options.maximumSessions === undefined ? {} : { deployment: options.maximumSessions }),
        ...(options.maximumPerAudience === undefined ? {} : { audience: options.maximumPerAudience }),
      });
    } catch {
      fail("invalid_broadcast_playback_session_configuration", 500);
    }
  }

  #prune(now) {
    for (const [id, value] of this.#sessions) if (value.expiresAt <= now) this.#sessions.delete(id);
  }

  async #authorizePlayback(authorizationHeader, resourceRef, time) {
    const path = `/broadcast/play/${resourceRef}`;
    try {
      const grant = await this.#authority.authorizeGatewayBearer(authorizationHeader, {
        action: "playback:manifest", path, grantKinds: ["playback"],
      }, time());
      const now = time();
      if (!grant || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now) notFound();
      await this.#authority.authorizeGatewayBearer(authorizationHeader, {
        action: "playback:segment", path, grantKinds: ["playback"],
      }, now);
      return grant;
    } catch { notFound(); }
  }

  async create({ authorizationHeader, resourceRef, origin, now = Date.now() }) {
    if (!RESOURCE.test(resourceRef || "") || origin !== this.#origin || !Number.isSafeInteger(now)) {
      notFound();
    }
    const time = playbackCheckTime(now, this.#clock);
    this.#prune(now);
    const grant = await this.#authorizePlayback(authorizationHeader, resourceRef, time);
    now = time();
    this.#prune(now);
    if (!grant || grant.grantKind !== "playback" || grant.resourceRef !== resourceRef
      || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now
      || typeof grant.audienceRef !== "string") notFound();
    let capacityScope;
    try { capacityScope = playbackCapacityScope(grant); } catch { notFound(); }
    if (!this.#capacity.allows(capacityScope, [...this.#sessions.values()].map(session => session.grantScope))) {
      fail("broadcast_playback_session_quota_reached", 429);
    }
    const sessionId = this.#idFactory();
    if (!SESSION.test(sessionId) || this.#sessions.has(sessionId)) {
      fail("invalid_broadcast_playback_session_id", 500);
    }
    const suffix = crypto.createHash("sha256").update(sessionId).digest("base64url").slice(0, 12);
    const cookieName = `__Secure-webrtc-broadcast-${suffix}`;
    const pathScope = `/broadcast/play/${resourceRef}/`;
    now = time();
    if (grant.expiresAt <= now) notFound();
    this.#sessions.set(sessionId, Object.freeze({
      sessionId, cookieName, resourceRef, audienceRef: grant.audienceRef,
      authorizationHeader, expiresAt: grant.expiresAt, grantScope: Object.freeze({
        tenantId: grant.tenantId, audienceRef: grant.audienceRef, deviceRef: grant.deviceRef, roomId: grant.roomId,
        programId: grant.programId, programEpoch: grant.programEpoch, resourceRef: grant.resourceRef,
        policyId: grant.policyId, policyRevision: grant.policyRevision,
      }),
    }));
    const maxAge = Math.max(1, Math.floor((grant.expiresAt - now) / 1_000));
    return Object.freeze({
      playbackSessionId: sessionId,
      manifestUrl: `${pathScope}index.m3u8`,
      expiresAt: grant.expiresAt,
      setCookie: sessionCookies(this.#sessions.get(sessionId), maxAge),
    });
  }

  async renew({ authorizationHeader, sessionId, resourceRef, cookieHeader, origin, now = Date.now() }) {
    if (!SESSION.test(sessionId || "") || !RESOURCE.test(resourceRef || "")
      || origin !== this.#origin || !Number.isSafeInteger(now)) notFound();
    const time = playbackCheckTime(now, this.#clock);
    this.#prune(now);
    const session = this.#sessions.get(sessionId);
    const ownsCookie = cookieEntries(cookieHeader).some(([name, value]) => (
      name === session?.cookieName && value === sessionId
    ));
    if (!session || !ownsCookie || session.resourceRef !== resourceRef) notFound();
    const grant = await this.#authorizePlayback(authorizationHeader, session.resourceRef, time);
    now = time();
    this.#prune(now);
    if (!grant || grant.grantKind !== "playback" || grant.resourceRef !== session.resourceRef
      || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now
      || session.expiresAt <= now
      || !sameGrantScope(session.grantScope, grant)
      || this.#sessions.get(sessionId) !== session) notFound();
    const renewed = Object.freeze({
      ...session, authorizationHeader, expiresAt: grant.expiresAt,
    });
    this.#sessions.set(sessionId, renewed);
    const maxAge = Math.max(1, Math.floor((grant.expiresAt - now) / 1_000));
    return Object.freeze({
      playbackSessionId: sessionId,
      manifestUrl: `/broadcast/play/${session.resourceRef}/index.m3u8`,
      expiresAt: grant.expiresAt,
      setCookie: sessionCookies(renewed, maxAge),
    });
  }

  #requestSession({ cookieHeader, method, resourceRef, file, query = "", range = "", origin, now = Date.now() }) {
    if (!new Set(["GET", "HEAD"]).has(method) || !RESOURCE.test(resourceRef || "")
      || !MEDIA_FILE.test(file || "") || (origin && origin !== this.#origin) || !Number.isSafeInteger(now)
      || typeof range !== "string" || range && !/^bytes=\d{0,16}-\d{0,16}$/.test(range)) notFound();
    this.#prune(now);
    const session = cookieEntries(cookieHeader)
      .map(([name, value]) => { const session = this.#sessions.get(value); return session?.cookieName === name ? session : undefined; })
      .find(value => value?.resourceRef === resourceRef);
    if (!session || session.expiresAt <= now) notFound();
    const manifest = MANIFEST_FILE.test(file);
    const normalizedQuery = parseQuery(query, manifest);
    const path = `/broadcast/play/${resourceRef}`;
    return { session, manifest, normalizedQuery, path, resourceRef, file, now };
  }

  /** Cheap rate-bucket identity only. A known session can still have a revoked
   * grant; authorize() must independently validate EVERY forwarded request. */
  rateLimitKey(input) {
    try { return this.#requestSession(input).session.sessionId; }
    catch { return null; }
  }

  async authorize(input) {
    const { session, manifest, normalizedQuery, path, resourceRef, file, now } = this.#requestSession(input);
    const time = playbackCheckTime(now, this.#clock);
    try {
      await this.#authority.authorizeGatewayBearer(session.authorizationHeader, {
        action: manifest ? "playback:manifest" : "playback:segment",
        path, grantKinds: ["playback"],
      }, time());
    } catch {
      notFound();
    }
    // A close/prune during async authorization must not release another media request.
    // A normal renewal preserves the immutable grantScope object and remains compatible.
    const currentTime = time();
    this.#prune(currentTime);
    if (session.expiresAt <= currentTime || this.#sessions.get(session.sessionId)?.grantScope !== session.grantScope) notFound();
    return Object.freeze({
      sessionId: session.sessionId,
      budgetScope: Object.freeze({ tenantId: session.grantScope.tenantId, audienceRef: session.grantScope.audienceRef }),
      upstreamPath: `/${resourceRef}/${file}${normalizedQuery ? `?${normalizedQuery}` : ""}`,
      authorizationHeader: session.authorizationHeader,
      cacheControl: "private, no-store, max-age=0",
    });
  }

  close({ sessionId, cookieHeader, origin, now = Date.now() }) {
    this.#prune(now);
    const session = this.#sessions.get(sessionId);
    const ownsCookie = cookieEntries(cookieHeader).some(([name, value]) => (
      name === session?.cookieName && value === sessionId
    ));
    if (!session || origin !== this.#origin || !ownsCookie) notFound();
    this.#sessions.delete(sessionId);
    return sessionCookies(session, 0);
  }

  // Internal port: caller must authorize current program ownership first.
  inspectProgramCapacity({ tenantId, programId, additionalSessions, now = Date.now() }) {
    const scope = playbackProgramScope({ tenantId, programId });
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(additionalSessions)
      || additionalSessions < 1 || additionalSessions > 10000) fail("invalid_broadcast_playback_inspection");
    this.#prune(now);
    return this.#capacity.inspectProgram(scope, [...this.#sessions.values()].map(s => s.grantScope), additionalSessions);
  }

  get size() { return this.#sessions.size; }
}
