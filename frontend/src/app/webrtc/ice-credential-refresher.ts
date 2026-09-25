import { IceTierPolicy, parseIceTierPolicy } from "./ice-policy";

/**
 * Source of the staged ICE policy of one room session. `current()` is always
 * usable synchronously (direct STUN never expires); `refresh()` must be
 * awaited before TURN credentials are handed to a PeerConnection.
 */
export interface IcePolicySource {
  current(): IceTierPolicy;
  /** A policy with unexpired TURN credentials, fetched fresh when possible; null if none can be had. */
  refresh(reason: string): Promise<IceTierPolicy | null>;
}

export interface IceRefreshGrant {
  readonly path: string;
  readonly token: string;
  readonly expiresAt: number;
}

export const ICE_REFRESH_PATH = "/api/ice-credentials";
// A TURN allocation started this close to expiry could be refused mid-gathering.
export const ICE_CREDENTIAL_SAFETY_MARGIN_MS = 30_000;
// Tier steps of many peers land together; one fetch serves all of them.
export const ICE_REFRESH_COALESCE_MS = 5_000;
export const ICE_REFRESH_RETRY_BASE_MS = 2_000;
export const ICE_REFRESH_RETRY_MAX_MS = 60_000;
const PROACTIVE_MIN_DELAY_MS = 15_000;
const FETCH_TIMEOUT_MS = 8_000;

export function parseIceRefreshGrant(raw: unknown): IceRefreshGrant | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["path", "token", "expiresAt"].includes(key))) return null;
  if (value["path"] !== ICE_REFRESH_PATH || typeof value["token"] !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(value["token"]) || !Number.isSafeInteger(value["expiresAt"])) return null;
  return Object.freeze({ path: ICE_REFRESH_PATH, token: value["token"], expiresAt: value["expiresAt"] as number });
}

export function fixedIcePolicySource(policy: IceTierPolicy): IcePolicySource {
  return { current: () => policy, refresh: async () => policy };
}

class IceRefreshFailure extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

interface RefresherPorts {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
  readonly updated?: (policy: IceTierPolicy) => void;
}

function logIceCredentials(event: string, detail: Record<string, unknown>): void {
  // Never the grant token, TURN usernames or credentials.
  console.warn("[icecred] " + JSON.stringify({ at: new Date().toISOString(), event, ...detail }));
}

/**
 * Keeps the TURN credentials of one room session fresh. The server issues them
 * with a short TTL (TURN REST); a tab or companion that stays in a room longer
 * must re-fetch them through its membership-bound grant before any new TURN
 * allocation, i.e. before a relay tier or an ICE restart. A proactive refresh
 * at half the remaining lifetime keeps `current()` valid in between.
 */
export class IceCredentialRefresher implements IcePolicySource {
  private policy: IceTierPolicy;
  private expiresAt: number;
  private fetchedAt: number;
  private inFlight: Promise<IceTierPolicy | null> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private revoked = false;
  // Background timers run only between start() and stop(); stop() is final.
  private running = false;
  private stopped = false;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly log: (event: string, detail: Record<string, unknown>) => void;

  constructor(initial: IceTierPolicy, private readonly grant: IceRefreshGrant, private readonly ports: RefresherPorts = {}) {
    this.policy = initial;
    this.expiresAt = grant.expiresAt;
    this.fetcher = ports.fetch ?? ((...args) => fetch(...args));
    this.now = ports.now ?? Date.now;
    this.log = ports.log ?? logIceCredentials;
    this.fetchedAt = this.now();
  }

  current(): IceTierPolicy {
    return this.policy;
  }

  credentialsExpireAt(): number {
    return this.expiresAt;
  }

  usable(now = this.now()): boolean {
    return this.expiresAt - now > ICE_CREDENTIAL_SAFETY_MARGIN_MS;
  }

  start(): void {
    if (this.stopped) return;
    this.running = true;
    this.schedule(this.proactiveDelay());
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  refresh(reason: string): Promise<IceTierPolicy | null> {
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (this.stopped || this.revoked) return Promise.resolve(this.usableOrNull(reason, now));
    if (now - this.fetchedAt < ICE_REFRESH_COALESCE_MS && this.usable(now)) return Promise.resolve(this.policy);
    const pending = this.fetchFresh(reason).finally(() => {
      if (this.inFlight === pending) this.inFlight = null;
    });
    this.inFlight = pending;
    return pending;
  }

  private async fetchFresh(reason: string): Promise<IceTierPolicy | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let status = 0;
    try {
      const response = await this.fetcher(this.grant.path, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: this.grant.token }),
      });
      status = response.status;
      const body = await response.json().catch(() => null) as { icePolicy?: unknown; expiresAt?: unknown; error?: unknown } | null;
      if (!response.ok) throw new IceRefreshFailure(typeof body?.error === "string" ? body.error : "http_error", status);
      const policy = parseIceTierPolicy(body?.icePolicy);
      const expiresAt = Number(body?.expiresAt);
      if (!policy || !Number.isSafeInteger(expiresAt)) throw new IceRefreshFailure("invalid_ice_refresh_response", status);
      const now = this.now();
      this.policy = policy;
      this.expiresAt = expiresAt;
      this.fetchedAt = now;
      this.failures = 0;
      this.log("refreshed", { reason, expiresInMs: expiresAt - now });
      this.ports.updated?.(policy);
      if (this.running) this.schedule(this.proactiveDelay());
      return policy;
    } catch (error) {
      this.failures += 1;
      const code = error instanceof IceRefreshFailure ? error.code
        : error instanceof Error ? error.name : "unknown";
      // 401/403: the membership that owned the grant is gone; retrying cannot help.
      this.revoked ||= status === 401 || status === 403;
      const usable = this.usable();
      this.log("refresh-failed", {
        reason, status, code, failures: this.failures, revoked: this.revoked, usable,
        expiresInMs: this.expiresAt - this.now(),
      });
      if (this.running && !this.revoked) this.schedule(this.retryDelay());
      return usable ? this.policy : null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private usableOrNull(reason: string, now: number): IceTierPolicy | null {
    if (this.usable(now)) return this.policy;
    this.log("credentials-expired", { reason, revoked: this.revoked, expiresInMs: this.expiresAt - now });
    return null;
  }

  private proactiveDelay(): number {
    const remaining = this.expiresAt - this.now() - ICE_CREDENTIAL_SAFETY_MARGIN_MS;
    return Math.max(PROACTIVE_MIN_DELAY_MS, Math.floor(remaining / 2));
  }

  private retryDelay(): number {
    return Math.min(ICE_REFRESH_RETRY_BASE_MS * 2 ** Math.min(this.failures - 1, 10), ICE_REFRESH_RETRY_MAX_MS);
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh("proactive");
    }, delayMs);
  }
}
