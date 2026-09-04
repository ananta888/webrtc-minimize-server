import crypto from "node:crypto";

const RESOURCE = /^res_[A-Za-z0-9_-]{16,64}$/;
const SESSION = /^pbs_[A-Za-z0-9_-]{24,64}$/;
const COOKIE_NAME = /^__Secure-webrtc-broadcast-[A-Za-z0-9_-]{8,16}$/;
const MEDIA_FILE = /^(?:[A-Za-z0-9_-]{1,96}\.(?:m3u8|mp4|m4s|vtt|key)|gap\.mp4)$/;
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

export class BroadcastPlaybackSessionStore {
  #authority;
  #origin;
  #sessions = new Map();
  #idFactory;
  #maximumSessions;
  #maximumPerAudience;

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
    this.#origin = origin.origin;
    this.#idFactory = options.idFactory || (() => `pbs_${crypto.randomBytes(24).toString("base64url")}`);
    this.#maximumSessions = options.maximumSessions ?? 1_024;
    this.#maximumPerAudience = options.maximumPerAudience ?? 4;
    if (!Number.isSafeInteger(this.#maximumSessions) || this.#maximumSessions < 1
      || !Number.isSafeInteger(this.#maximumPerAudience) || this.#maximumPerAudience < 1) {
      fail("invalid_broadcast_playback_session_configuration", 500);
    }
  }

  #prune(now) {
    for (const [id, value] of this.#sessions) if (value.expiresAt <= now) this.#sessions.delete(id);
  }

  async create({ authorizationHeader, resourceRef, origin, now = Date.now() }) {
    if (!RESOURCE.test(resourceRef || "") || origin !== this.#origin || !Number.isSafeInteger(now)) {
      notFound();
    }
    this.#prune(now);
    const path = `/broadcast/play/${resourceRef}`;
    let grant;
    try {
      grant = await this.#authority.authorizeGatewayBearer(authorizationHeader, {
        action: "playback:manifest", path, grantKinds: ["playback"],
      }, now);
      await this.#authority.authorizeGatewayBearer(authorizationHeader, {
        action: "playback:segment", path, grantKinds: ["playback"],
      }, now);
    } catch {
      notFound();
    }
    if (!grant || grant.grantKind !== "playback" || grant.resourceRef !== resourceRef
      || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now
      || typeof grant.audienceRef !== "string") notFound();
    if (this.#sessions.size >= this.#maximumSessions
      || [...this.#sessions.values()].filter(({ audienceRef }) => audienceRef === grant.audienceRef).length >= this.#maximumPerAudience) {
      fail("broadcast_playback_session_quota_reached", 429);
    }
    const sessionId = this.#idFactory();
    if (!SESSION.test(sessionId) || this.#sessions.has(sessionId)) {
      fail("invalid_broadcast_playback_session_id", 500);
    }
    const suffix = crypto.createHash("sha256").update(sessionId).digest("base64url").slice(0, 12);
    const cookieName = `__Secure-webrtc-broadcast-${suffix}`;
    const pathScope = `/broadcast/play/${resourceRef}/`;
    this.#sessions.set(sessionId, Object.freeze({
      sessionId, cookieName, resourceRef, audienceRef: grant.audienceRef,
      authorizationHeader, expiresAt: grant.expiresAt,
    }));
    const maxAge = Math.max(1, Math.floor((grant.expiresAt - now) / 1_000));
    return Object.freeze({
      playbackSessionId: sessionId,
      manifestUrl: `${pathScope}index.m3u8`,
      expiresAt: grant.expiresAt,
      setCookie: `${cookieName}=${sessionId}; Path=${pathScope}; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`,
    });
  }

  async authorize({ cookieHeader, method, resourceRef, file, query = "", origin, now = Date.now() }) {
    if (!new Set(["GET", "HEAD"]).has(method) || !RESOURCE.test(resourceRef || "")
      || !MEDIA_FILE.test(file || "") || (origin && origin !== this.#origin) || !Number.isSafeInteger(now)) notFound();
    this.#prune(now);
    const session = cookieEntries(cookieHeader)
      .map(([, value]) => this.#sessions.get(value))
      .find((value) => value?.resourceRef === resourceRef);
    if (!session || session.expiresAt <= now) notFound();
    const manifest = MANIFEST_FILE.test(file);
    const normalizedQuery = parseQuery(query, manifest);
    const path = `/broadcast/play/${resourceRef}`;
    try {
      await this.#authority.authorizeGatewayBearer(session.authorizationHeader, {
        action: manifest ? "playback:manifest" : "playback:segment",
        path, grantKinds: ["playback"],
      }, now);
    } catch {
      notFound();
    }
    return Object.freeze({
      sessionId: session.sessionId,
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
    const pathScope = `/broadcast/play/${session.resourceRef}/`;
    return `${session.cookieName}=; Path=${pathScope}; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
  }

  get size() { return this.#sessions.size; }
}
