import { exactModerationObject, parseSourceModerationState, SourceModerationState } from "./source-moderation-contract";

export interface SourceModerationContext { readonly key: string; readonly programId: string; readonly programEpoch: number }
export interface SourceModerationView {
  readonly phase: "idle" | "pending" | "ready" | "revoking" | "revoked" | "unavailable" | "stale";
  readonly state: SourceModerationState | null;
}
interface Ports {
  context(): SourceModerationContext | null; send(message: object): void; changed(view: SourceModerationView): void;
  nonce?(): string; monotonic?(): number; wall?(): number;
}
/** Owns bounded metadata only; never owns capture, publisher keys or transport. */
export class SourceModerationController {
  private view: SourceModerationView = { phase: "idle", state: null };
  private owner: string | null = null;
  private deadline = 0;
  private lastTime = -1;
  private closed = false;
  private pending: { id: string; consentId: string | null; context: SourceModerationContext } | null = null;
  constructor(private readonly ports: Ports) {}
  private key(): string | null {
    const c = this.ports.context();
    return c ? JSON.stringify([c.key, c.programId, c.programEpoch]) : null;
  }
  private now(): number {
    const now = (this.ports.monotonic ?? (() => performance.now()))();
    if (!Number.isFinite(now) || now < 0 || now < this.lastTime) { this.closed = true; this.reset("unavailable"); return NaN; }
    this.lastTime = now; return now;
  }
  private wall(): number { return (this.ports.wall ?? Date.now)(); }
  private set(phase: SourceModerationView["phase"], state: SourceModerationState | null = null): void {
    this.view = Object.freeze({ phase, state }); this.ports.changed(this.view);
  }
  private reset(phase: SourceModerationView["phase"]): void { this.pending = null; this.owner = null; this.set(phase); }
  tick(): void {
    if (this.closed || !this.owner) return;
    if (this.key() !== this.owner) { this.reset("stale"); return; }
    const now = this.now(), wall = this.wall(), s = this.view.state;
    if (!Number.isFinite(now)) return;
    if (!Number.isSafeInteger(wall) || now >= this.deadline || s && (wall >= s.expiresAt || wall < s.observedAt - 1000)) {
      this.reset(this.pending ? "unavailable" : "stale");
    }
  }
  query(): void {
    this.tick();
    if (this.closed || this.pending) return;
    this.request(null);
  }
  canRevoke(consentId: string, snapshot: SourceModerationState | null): boolean {
    this.tick();
    return !this.closed && this.view.phase === "ready" && !!snapshot && this.view.state === snapshot
      && snapshot.sources.some(s => s.consentId === consentId && s.expiresAt > this.wall());
  }
  revoke(consentId: string, snapshot: SourceModerationState | null): void {
    if (!this.canRevoke(consentId, snapshot)) return;
    this.request(consentId, snapshot!);
  }
  private request(consentId: string | null, snapshot?: SourceModerationState): void {
    const context = this.ports.context(), now = this.now();
    if (!context || this.closed || !Number.isFinite(now)) { this.reset("unavailable"); return; }
    try {
      const id = (this.ports.nonce ?? (() => crypto.randomUUID()))();
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw new Error("invalid_nonce");
      this.owner = this.key(); this.deadline = now + 5000;
      this.pending = { id, consentId, context };
      this.set(consentId ? "revoking" : "pending");
      this.ports.send({ version: 1, type: `broadcast-source-moderation-${consentId ? "revoke" : "query"}`,
        requestId: id, programId: context.programId, programEpoch: context.programEpoch,
        ...(snapshot ? { consentId, programRevision: snapshot.programRevision, fencingRevision: snapshot.fencingRevision } : {}) });
    } catch { this.reset("unavailable"); }
  }
  receive(raw: unknown): void {
    this.tick();
    const p = this.pending;
    if (this.closed || !p || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const message = raw as Record<string, unknown>;
    if (message["requestId"] !== p.id) return;
    if (message["version"] === 1 && message["type"] === "broadcast-source-moderation-unavailable"
      && exactModerationObject(raw, ["version", "type", "requestId"])) { this.reset("unavailable"); return; }
    if (p.consentId) {
      if (!exactModerationObject(raw, ["version", "type", "requestId", "programId", "programEpoch", "consentId"])
        || message["version"] !== 1 || message["type"] !== "broadcast-source-moderation-revoked"
        || message["programId"] !== p.context.programId || message["programEpoch"] !== p.context.programEpoch
        || message["consentId"] !== p.consentId) { this.reset("unavailable"); return; }
      this.reset("revoked"); return;
    }
    const state = parseSourceModerationState(raw), wall = this.wall();
    if (!state || state.programId !== p.context.programId || state.programEpoch !== p.context.programEpoch
      || !Number.isSafeInteger(wall) || wall >= state.expiresAt || wall < state.observedAt - 1000) {
      this.reset("unavailable"); return;
    }
    this.pending = null; this.set("ready", state);
  }
  destroy(): void { this.closed = true; this.reset("idle"); }
}
