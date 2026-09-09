import { SourceInvitation, parseSourceInvitations } from "./source-invitation-contract";
import { OwnSourcePublication, SourcePublisherContext, parseOwnSourcePublications, parseSourceApproval, parseSourceStop, samePublisherContext } from "./trusted-source-actions";
import { TrustedSourceLease, parseTrustedSourceLease, parseTrustedSourceSignal, sameTrustedSource, sourceFail } from "./trusted-source-contract";
import type { TrustedSourcePublisher } from "./trusted-source-publisher";
import type { TrustedDecryptConsent } from "./trusted-decrypt-key-lifecycle";

type References = Readonly<{ tenantId: string; subjectRef: string; deviceRef: string }>;
type Publisher = Pick<TrustedSourcePublisher, "stop" | "renew" | "receiveSignal">;
type Phase = "waiting-consent" | "waiting-receiver" | "waiting-key" | "sending" | "stopped" | "failed";
interface Choice { readonly publication: OwnSourcePublication; readonly track: MediaStreamTrack }
interface Editor {
  readonly request: SourceInvitation; readonly context: SourcePublisherContext;
  references?: References; choices: readonly Choice[]; ready: boolean; until: number;
}
interface Publication {
  readonly request: SourceInvitation; readonly context: SourcePublisherContext; readonly references: References;
  readonly choice: Choice; readonly controller: AbortController; readonly ttlMs: number; readonly requestedAt: number;
  phase: Phase; until: number; consent?: TrustedDecryptConsent; lease?: TrustedSourceLease; publisher?: Publisher;
  queued: Record<string, unknown>[]; queuedBytes: number; renewals: TrustedSourceLease[];
}
export interface SourceWorkflowView {
  readonly preparing: boolean;
  readonly selection: Readonly<{ requestId: string; packagerRef: string; programId: string; publications: readonly OwnSourcePublication[] }> | null;
  readonly error: string;
  readonly publications: readonly Readonly<{ requestId: string; source: OwnSourcePublication["source"]; phase: Phase; expiresAt: number }>[];
}
export interface SourceWorkflowPorts {
  context(): SourcePublisherContext | null;
  references(context: SourcePublisherContext): Promise<References>;
  track(publication: OwnSourcePublication): MediaStreamTrack | null;
  send(message: object): void;
  start(lease: TrustedSourceLease, track: MediaStreamTrack, signal: AbortSignal,
    authorized: (lease: TrustedSourceLease) => boolean, state: (value: "waiting-key" | "sending" | "stopped" | "failed") => void): Promise<Publisher>;
  changed(view: SourceWorkflowView): void;
  clock?: () => number;
}

/** Local consent and sender lifecycle only. Membership and leases remain server-owned. */
export class TrustedSourceWorkflow {
  private editor: Editor | null = null;
  private readonly publications = new Map<string, Publication>();
  private error = "";
  private destroyed = false;
  private readonly now: () => number;
  constructor(private readonly ports: SourceWorkflowPorts) { this.now = ports.clock ?? Date.now; }

  async prepare(input: SourceInvitation): Promise<void> {
    const context = this.ports.context();
    if (!context || this.destroyed || this.editor || this.liveCount() >= 4 || this.publications.size >= 16) return;
    let editor: Editor | undefined;
    try {
      const [request] = parseSourceInvitations({ responseVersion: 1, requests: [input] }, context.roomId, context.peerId, this.now());
      if (request.targetPeerId !== context.peerId || request.state !== "pending" || request.expiresAt <= this.now()
        || this.publications.has(request.requestId)) return sourceFail();
      editor = { request, context, ready: false, choices: [], until: this.now() + 5000 };
      this.editor = editor; this.error = ""; this.emit();
      editor.references = await this.ports.references(context);
      if (this.editor !== editor || !this.current(context) || this.now() >= editor.until) return;
      this.ports.send({ version: 1, type: "trusted-source-publications" });
    } catch {
      if (!editor || this.editor === editor) { this.editor = null; this.error = "trusted_source_prepare_failed"; this.emit(); }
    }
  }

  cancelSelection(): void { this.editor = null; this.emit(); }

  approve(requestId: string, publicationId: string, ttlMs: number, trigger: unknown): void {
    const editor = this.editor, choice = editor?.choices.find(item => item.publication.publicationId === publicationId);
    try {
      if (this.destroyed || trigger !== "user-action" || !editor?.ready || !editor.references || !choice
        || requestId !== editor.request.requestId || !this.current(editor.context) || this.now() >= editor.until
        || editor.request.expiresAt <= this.now() || ![60000, 300000, 600000].includes(ttlMs)
        || this.ports.track(choice.publication) !== choice.track || choice.track.readyState !== "live"
        || this.liveCount() >= 4 || [...this.publications.values()].some(p => this.live(p)
          && p.choice.publication.publicationId === publicationId)) return sourceFail();
      const publication: Publication = { request: editor.request, context: editor.context, choice,
        references: editor.references, controller: new AbortController(), requestedAt: this.now(), ttlMs,
        queued: [], queuedBytes: 0, renewals: [],
        phase: "waiting-consent", until: this.now() + 5000 };
      this.editor = null; this.publications.set(requestId, publication); this.error = "";
      this.ports.send({ version: 1, type: "trusted-source-approve", approval: {
        requestVersion: 1, trigger: "user-action", requestId, roomId: publication.context.roomId,
        deviceFingerprint: publication.context.fingerprint, publicationId,
        expectedPublicationEpoch: choice.publication.publicationEpoch, ttlMs,
      } });
    } catch {
      const publication = this.publications.get(requestId);
      if (publication) this.stop(publication, true);
      this.editor = null; this.error = "trusted_source_approval_failed";
    }
    this.emit();
  }

  receive(raw: Record<string, unknown>): void {
    if (this.destroyed || typeof raw["type"] !== "string" || !raw["type"].startsWith("trusted-source-")) return;
    this.tick();
    try {
      if (raw["type"] === "trusted-source-publications") {
        const editor = this.editor;
        if (!editor || !editor.references || editor.ready || !this.current(editor.context)) return;
        const response = parseOwnSourcePublications(raw, editor.context);
        editor.choices = response.publications.filter(p => p.source === editor.request.sourceKind).flatMap(publication => {
          const track = this.ports.track(publication);
          return track?.readyState === "live" ? [{ publication, track }] : [];
        });
        editor.ready = true;
        editor.until = Math.min(this.now() + 30000, editor.request.expiresAt);
      } else if (raw["type"] === "trusted-source-approved") {
        const approval = parseSourceApproval(raw, this.now()), p = this.publications.get(approval.requestId);
        if (!p || !this.current(p.context)) return;
        if (!this.consentMatches(p, approval.consent)) return sourceFail();
        if (!this.live(p)) { this.revokeConsent(p, approval.consent); return; }
        if (p.consent && !this.equalConsent(p.consent, approval.consent)) return sourceFail();
        p.consent = approval.consent;
        if (p.phase === "waiting-consent") p.phase = "waiting-receiver";
        if (p.lease && !p.publisher) this.start(p);
      } else if (raw["type"] === "trusted-source-publisher-lease") {
        if (Object.keys(raw).sort().join() !== "lease,type,version" || raw["version"] !== 1) return sourceFail();
        const lease = parseTrustedSourceLease(raw["lease"], this.now());
        const p = [...this.publications.values()].find(p => this.live(p) && this.leaseMatches(p, lease));
        if (!p) return;
        if (p.consent && !this.equalConsent(p.consent, lease.consent)) return sourceFail();
        if (p.publisher) {
          p.publisher.renew(lease); p.lease = lease;
        } else {
          if (p.lease) {
            const previous = p.renewals.at(-1) ?? p.lease;
            if (!sameTrustedSource(previous, lease)) return sourceFail();
            if (lease.revision === previous.revision && lease.issuedAt === previous.issuedAt && lease.expiresAt === previous.expiresAt) return;
            if (lease.revision !== previous.revision + 1 || lease.expiresAt <= previous.expiresAt
              || lease.issuedAt < previous.issuedAt || p.renewals.length >= 4) return sourceFail();
            p.renewals.push(lease);
          } else {
            if (lease.revision !== 1) return sourceFail();
            p.lease = lease;
            if (p.consent) this.start(p);
          }
        }
      } else if (raw["type"] === "trusted-source-agent-signal") {
        const p = [...this.publications.values()].find(p => this.live(p) && p.lease?.sourceLeaseId === raw["sourceLeaseId"]);
        if (p?.lease) {
          parseTrustedSourceSignal(raw, p.lease);
          if (p.publisher) void p.publisher.receiveSignal(raw).catch(() => { this.stop(p, true); this.emit(); });
          else {
            const size = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
            if (p.queued.length >= 32 || p.queuedBytes + size > 65536) return sourceFail();
            p.queued.push(raw); p.queuedBytes += size;
          }
        }
      } else if (raw["type"] === "trusted-source-publisher-stop" || raw["type"] === "trusted-source-revoked") {
        // Strict scoped stop messages; arbitrary remote strings cannot revoke another source.
        const revoked = raw["type"] === "trusted-source-revoked";
        const fields = revoked ? ["consentId", "type", "version"] : ["version", "type", "sourceLeaseId", "leaseRevision",
          "consentId", "assignmentId", "fencingRevision", "expiresAt", "reasonCode"];
        if (raw["version"] !== 1 || Object.keys(raw).sort().join() !== fields.sort().join()
          || typeof raw["consentId"] !== "string" || !/^cns_[A-Za-z0-9_-]{16,64}$/.test(raw["consentId"])) return sourceFail();
        if (!revoked) parseSourceStop(raw);
        for (const p of this.publications.values()) {
          if (p.consent?.consentId !== raw["consentId"]) continue;
          if (revoked || p.lease && raw["sourceLeaseId"] === p.lease.sourceLeaseId
            && raw["assignmentId"] === p.lease.assignmentId && raw["fencingRevision"] === p.lease.fencingRevision
            && Number(raw["leaseRevision"]) >= p.lease.revision) this.stop(p, false, false);
        }
      } else return sourceFail();
    } catch {
      // An invalid source-control message must never turn a pending local choice into authority.
      this.editor = null; this.error = "trusted_source_control_invalid";
      for (const p of this.publications.values()) if (this.live(p)) this.stop(p, true);
    }
    this.emit();
  }

  private start(p: Publication): void {
    if (!p.lease || !p.consent || p.phase === "waiting-key" || !this.live(p)) return;
    const lease = p.lease;
    p.phase = "waiting-key";
    void this.ports.start(lease, p.choice.track, p.controller.signal,
      candidate => this.authorized(p, candidate), state => {
        if (!this.live(p)) return;
        if (state === "stopped" || state === "failed") this.stop(p, state === "failed");
        else p.phase = state;
        this.emit();
      }).then(publisher => {
        if (!this.authorized(p, lease)) { publisher.stop(); return; }
        p.publisher = publisher;
        for (const renewal of p.renewals) { publisher.renew(renewal); p.lease = renewal; }
        p.renewals = [];
        const queued = p.queued; p.queued = []; p.queuedBytes = 0;
        for (const message of queued) void publisher.receiveSignal(message).catch(() => { this.stop(p, true); this.emit(); });
      }).catch(() => { if (this.live(p)) this.stop(p, true); this.emit(); });
  }

  revoke(requestId: string): void {
    const publication = this.publications.get(requestId);
    if (publication) this.stop(publication, false);
    this.emit();
  }
  tick(): void {
    if (this.editor && (!this.current(this.editor.context) || this.now() >= this.editor.until)) {
      this.editor = null; this.error = "trusted_source_selection_expired";
    }
    for (const p of this.publications.values()) {
      if (this.live(p) && (!this.current(p.context) || this.ports.track(p.choice.publication) !== p.choice.track
        || p.choice.track.readyState !== "live" || this.now() < p.requestedAt
        || this.now() >= (p.lease?.expiresAt ?? p.until) || p.consent && this.now() >= p.consent.expiresAt)) this.stop(p, true);
    }
    // Retain bounded tombstones briefly so late approval can be revoked, never activated.
    for (const [id, p] of this.publications) if (!this.live(p) && this.now() > p.until + 30000) this.publications.delete(id);
    this.emit();
  }
  destroy(): void {
    this.destroyed = true; this.editor = null;
    for (const p of this.publications.values()) this.stop(p, false);
    this.publications.clear(); this.emit();
  }
  private current(context: SourcePublisherContext): boolean { return !this.destroyed && samePublisherContext(context, this.ports.context()); }
  private live(p: Publication): boolean { return !p.controller.signal.aborted; }
  private liveCount(): number { return [...this.publications.values()].filter(p => this.live(p)).length; }
  private equalConsent(a: TrustedDecryptConsent, b: TrustedDecryptConsent): boolean {
    return Object.keys(a).every(key => a[key as keyof TrustedDecryptConsent] === b[key as keyof TrustedDecryptConsent]);
  }
  private consentMatches(p: Publication, c: TrustedDecryptConsent): boolean {
    return c.roomId === p.context.roomId && c.roomEpoch === p.context.roomEpoch && c.programId === p.request.programId
      && c.programEpoch === p.request.programEpoch && c.sourceKind === p.request.sourceKind
      && c.granteePackagerRef === p.request.packagerRef && c.tenantId === p.references.tenantId
      && c.grantorSubjectRef === p.references.subjectRef && c.grantedAt >= p.requestedAt - 5000
      && c.expiresAt <= p.requestedAt + p.ttlMs + 1000;
  }
  private leaseMatches(p: Publication, lease: TrustedSourceLease): boolean {
    return this.consentMatches(p, lease.consent) && lease.publisherPeerId === p.context.peerId
      && lease.publisherDeviceRef === p.references.deviceRef && lease.publicationId === p.choice.publication.publicationId
      && lease.publicationEpoch === p.choice.publication.publicationEpoch;
  }
  private authorized(p: Publication, lease: TrustedSourceLease): boolean {
    return this.live(p) && this.current(p.context) && this.leaseMatches(p, lease) && !!p.consent
      && this.equalConsent(p.consent, lease.consent) && lease.expiresAt > this.now()
      && this.ports.track(p.choice.publication) === p.choice.track && p.choice.track.readyState === "live";
  }
  private revokeConsent(p: Publication, consent: TrustedDecryptConsent): void {
    if (samePublisherContext(p.context, this.ports.context())) {
      try { this.ports.send({ version: 1, type: "trusted-source-revoke", consentId: consent.consentId }); } catch { /* Lease remains bounded. */ }
    }
  }
  private stop(p: Publication, failed: boolean, remote = true): void {
    if (!this.live(p)) return;
    p.phase = failed ? "failed" : "stopped"; p.until = this.now();
    p.controller.abort();
    try { p.publisher?.stop(); } catch { p.phase = "failed"; }
    p.publisher = undefined; p.queued = []; p.queuedBytes = 0; p.renewals = [];
    if (remote && p.consent) this.revokeConsent(p, p.consent);
  }
  private emit(): void {
    this.ports.changed(Object.freeze({ preparing: !!this.editor && !this.editor.ready,
      selection: this.editor?.ready ? Object.freeze({ requestId: this.editor.request.requestId,
        packagerRef: this.editor.request.packagerRef, programId: this.editor.request.programId,
        publications: Object.freeze(this.editor.choices.map(c => c.publication)) }) : null,
      error: this.error, publications: Object.freeze([...this.publications.values()].map(p => Object.freeze({
        requestId: p.request.requestId, source: p.choice.publication.source, phase: p.phase, expiresAt: p.consent?.expiresAt ?? p.until,
      }))) }));
  }
}
