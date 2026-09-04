export type BroadcastModerationActionKind =
  | "source-request"
  | "source-remove"
  | "own-source-revoke"
  | "layout-change"
  | "packager-select"
  | "packager-standby"
  | "packager-handoff"
  | "program-stop";

export interface BroadcastModerationSnapshot {
  readonly tenantId: string;
  readonly roomId: string;
  readonly programId: string;
  readonly programRevision: number;
  readonly programEpoch: number;
  readonly leaseEpoch: number;
  readonly actorSubjectRef: string;
  readonly actorRole: "owner" | "moderator" | "presenter" | "packager" | "viewer";
}

export interface BroadcastModerationDraft {
  readonly action: BroadcastModerationActionKind;
  readonly targetLabel: string;
  readonly targetSubjectRef?: string;
  readonly sourceId?: string;
  readonly sourceKind?: "microphone" | "camera" | "screen" | "screen-audio";
  readonly layout?: "single" | "screen-presenter" | "side-by-side" | "active-speaker" | "grid" | "waiting-slate" | "end-slate";
  readonly primaryAgentId?: string;
  readonly standbyAgentIds?: readonly string[];
  readonly reasonCode?: string;
}

export interface BroadcastModerationConfirmationView {
  readonly confirmationId: string;
  readonly heading: string;
  readonly consequence: string;
  readonly targetLabel: string;
  readonly expiresAt: number;
}

export interface BroadcastModerationActionEnvelope extends BroadcastModerationDraft {
  readonly workflowVersion: 1;
  readonly type: "broadcast-moderation-action";
  readonly actionId: string;
  readonly trigger: "user-action";
  readonly tenantId: string;
  readonly roomId: string;
  readonly programId: string;
  readonly actorSubjectRef: string;
  readonly actorRole: BroadcastModerationSnapshot["actorRole"];
  readonly expectedProgramRevision: number;
  readonly expectedProgramEpoch: number;
  readonly expectedLeaseEpoch?: number;
  readonly confirmation: {
    readonly confirmationId: string;
    readonly confirmedAt: number;
    readonly expiresAt: number;
  };
}

export interface BroadcastModerationResult {
  readonly programRevision: number;
  readonly programEpoch: number;
  readonly leaseEpoch: number;
}

export interface BroadcastModerationActionPort {
  execute(action: BroadcastModerationActionEnvelope, signal: AbortSignal): Promise<BroadcastModerationResult>;
}

export interface BroadcastOwnSourceSafetyPort {
  fenceStopAndClear(sourceId: string): Promise<void>;
}

const ACTION_COPY: Readonly<Record<BroadcastModerationActionKind, readonly [string, string]>> = Object.freeze({
  "source-request": ["Quelle anfragen", "Die andere Person entscheidet selbst, ob sie diese Quelle freigibt."],
  "source-remove": ["Quelle entfernen", "Die Quelle wird aus dem Programmbild entfernt und ihr Broadcast-Zugriff widerrufen."],
  "own-source-revoke": ["Eigene Quelle sofort widerrufen", "Deine lokale Broadcast-Kopie stoppt zuerst; die Fläche wird gelöscht und durch ein sicheres Wartebild ersetzt."],
  "layout-change": ["Programmlayout ändern", "Zuschauer können während der kontrollierten Neukonfiguration eine kurze Unterbrechung sehen."],
  "packager-select": ["Packager auswählen", "Nur das aktive Gerät erhält den Writer-Fence und nötige Quellschlüssel; Standbys bleiben schlüssellos."],
  "packager-standby": ["Standbys ändern", "Standbys werden nur vorbereitet und erhalten noch keine Quellschlüssel."],
  "packager-handoff": ["Packager übergeben", "Der bisherige Writer wird zuerst gefencet; beim Wechsel ist eine kurze Unterbrechung möglich."],
  "program-stop": ["Sendung beenden", "Publikation und Grants werden widerrufen; lokale Broadcast-Kopien werden beendet."],
});
const TENANT = /^tn_[A-Za-z0-9_-]{16,64}$/;
const SUBJECT = /^sub_[A-Za-z0-9_-]{16,64}$/;
const ROOM = /^[a-z0-9][a-z0-9-]{5,47}$/;
const PROGRAM = /^prg_[A-Za-z0-9_-]{16,64}$/;
const SOURCE = /^src_[A-Za-z0-9_-]{16,64}$/;
const AGENT = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REASON = /^[A-Z][A-Z0-9_]{1,31}$/;

export class BroadcastModerationWorkflowError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BroadcastModerationWorkflowError";
  }
}

const fail = (code: string): never => { throw new BroadcastModerationWorkflowError(code); };

function normalizeDraft(value: BroadcastModerationDraft): BroadcastModerationDraft {
  let clone: BroadcastModerationDraft;
  try {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > 8 * 1024) fail("invalid_broadcast_moderation_draft");
    clone = JSON.parse(serialized) as BroadcastModerationDraft;
  } catch (error) {
    if (error instanceof BroadcastModerationWorkflowError) throw error;
    return fail("invalid_broadcast_moderation_draft");
  }
  if (!clone || typeof clone !== "object" || Array.isArray(clone)
    || !Object.hasOwn(ACTION_COPY, clone.action)
    || typeof clone.targetLabel !== "string" || clone.targetLabel.length < 1 || clone.targetLabel.length > 80) {
    fail("invalid_broadcast_moderation_draft");
  }
  const standbys = clone.standbyAgentIds || [];
  if (standbys.length > 2 || new Set(standbys).size !== standbys.length
    || standbys.some((agentId) => !AGENT.test(agentId))) fail("invalid_broadcast_packager_selection");
  if (clone.primaryAgentId !== undefined && (!AGENT.test(clone.primaryAgentId)
    || standbys.includes(clone.primaryAgentId))) fail("invalid_broadcast_packager_selection");
  if (clone.sourceId !== undefined && !SOURCE.test(clone.sourceId)) fail("invalid_broadcast_source");
  if (clone.targetSubjectRef !== undefined && !SUBJECT.test(clone.targetSubjectRef)) {
    fail("invalid_broadcast_subject");
  }
  if (clone.reasonCode !== undefined && !REASON.test(clone.reasonCode)) fail("invalid_broadcast_reason");
  return Object.freeze({ ...clone, ...(clone.standbyAgentIds ? { standbyAgentIds: Object.freeze([...standbys]) } : {}) });
}

function validateSnapshot(value: BroadcastModerationSnapshot): void {
  if (!value || !TENANT.test(value.tenantId) || !ROOM.test(value.roomId) || !PROGRAM.test(value.programId)
    || !SUBJECT.test(value.actorSubjectRef) || !Number.isSafeInteger(value.programRevision)
    || value.programRevision < 1 || !Number.isSafeInteger(value.programEpoch) || value.programEpoch < 1
    || !Number.isSafeInteger(value.leaseEpoch) || value.leaseEpoch < 1) {
    fail("invalid_broadcast_moderation_snapshot");
  }
}

export class BroadcastModerationWorkflow {
  private pending: {
    readonly draft: BroadcastModerationDraft;
    readonly snapshot: BroadcastModerationSnapshot;
    readonly confirmation: BroadcastModerationConfirmationView;
  } | null = null;
  private controller: AbortController | null = null;
  private conflict: string | null = null;

  constructor(
    private readonly actions: BroadcastModerationActionPort,
    private readonly ownSourceSafety: BroadcastOwnSourceSafetyPort,
    private readonly clock: () => number = Date.now,
    private readonly nonce: () => string = () => crypto.randomUUID().replaceAll("-", ""),
  ) {}

  request(
    draftValue: BroadcastModerationDraft,
    snapshot: BroadcastModerationSnapshot,
    trigger: unknown,
  ): BroadcastModerationConfirmationView {
    if (trigger !== "user-action") fail("explicit_broadcast_moderation_action_required");
    validateSnapshot(snapshot);
    const draft = normalizeDraft(draftValue);
    if (draft.action === "own-source-revoke" && draft.targetSubjectRef !== snapshot.actorSubjectRef) {
      fail("broadcast_own_source_required");
    }
    const now = this.clock();
    const [heading, consequence] = ACTION_COPY[draft.action];
    const confirmation = Object.freeze({
      confirmationId: `bcf_${this.nonce().slice(0, 32)}`,
      heading,
      consequence,
      targetLabel: draft.targetLabel,
      expiresAt: now + 120_000,
    });
    if (!/^bcf_[A-Za-z0-9_-]{16,32}$/.test(confirmation.confirmationId)) {
      fail("invalid_broadcast_confirmation_id");
    }
    this.conflict = null;
    this.pending = { draft, snapshot: Object.freeze({ ...snapshot }), confirmation };
    return confirmation;
  }

  cancel(): void { this.pending = null; }

  conflictCode(): string | null { return this.conflict; }

  async confirm(confirmationId: string, trigger: unknown): Promise<BroadcastModerationResult> {
    if (trigger !== "user-action") fail("explicit_broadcast_moderation_confirmation_required");
    const pending = this.pending;
    this.pending = null;
    const now = this.clock();
    if (!pending) throw new BroadcastModerationWorkflowError("broadcast_moderation_confirmation_expired");
    if (pending.confirmation.confirmationId !== confirmationId
      || pending.confirmation.expiresAt <= now) fail("broadcast_moderation_confirmation_expired");
    const { draft, snapshot, confirmation } = pending;
    const action: BroadcastModerationActionEnvelope = Object.freeze({
      ...draft,
      workflowVersion: 1,
      type: "broadcast-moderation-action",
      actionId: `bma_${this.nonce().slice(0, 32)}`,
      trigger: "user-action",
      tenantId: snapshot.tenantId,
      roomId: snapshot.roomId,
      programId: snapshot.programId,
      actorSubjectRef: snapshot.actorSubjectRef,
      actorRole: snapshot.actorRole,
      expectedProgramRevision: snapshot.programRevision,
      expectedProgramEpoch: snapshot.programEpoch,
      ...(draft.action === "packager-handoff" ? { expectedLeaseEpoch: snapshot.leaseEpoch } : {}),
      confirmation: Object.freeze({
        confirmationId,
        confirmedAt: now,
        expiresAt: confirmation.expiresAt,
      }),
    });
    this.controller = new AbortController();
    try {
      if (draft.action === "own-source-revoke") {
        if (!draft.sourceId) throw new BroadcastModerationWorkflowError("invalid_broadcast_source");
        await this.ownSourceSafety.fenceStopAndClear(draft.sourceId);
      }
      const result = await this.actions.execute(action, this.controller.signal);
      this.conflict = null;
      return result;
    } catch (error) {
      const code = error instanceof BroadcastModerationWorkflowError
        ? error.code
        : error instanceof Error ? error.message : "broadcast_moderation_failed";
      if (code === "stale_broadcast_revision" || code === "stale_broadcast_epoch"
        || code === "stale_broadcast_lease_epoch") this.conflict = code;
      throw error;
    } finally {
      this.controller = null;
    }
  }

  destroy(): void {
    this.pending = null;
    this.controller?.abort(new DOMException("destroy", "AbortError"));
    this.controller = null;
  }
}
