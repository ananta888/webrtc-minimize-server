import { BroadcastModerationWorkflowError, normalizeModerationDraft, normalizeModerationResult, validateModerationSnapshot } from "./broadcast-moderation-validation";
export { BroadcastModerationWorkflowError } from "./broadcast-moderation-validation";

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

export interface BroadcastModerationActionEnvelope extends Omit<BroadcastModerationDraft, "targetLabel"> {
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
  fenceStopAndClear(sourceId: string, signal: AbortSignal): Promise<void>;
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
const fail = (code: string): never => { throw new BroadcastModerationWorkflowError(code); };

/** A non-cooperative adapter may finish later, but cannot resume this workflow. */
function abortable<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    let result: Promise<T>;
    try { result = start(); } catch (error) { signal.removeEventListener("abort", aborted); reject(error); return; }
    Promise.resolve(result).then(value => {
      signal.removeEventListener("abort", aborted);
      if (signal.aborted) aborted(); else resolve(value);
    }, error => { signal.removeEventListener("abort", aborted); reject(error); });
  });
}

export class BroadcastModerationWorkflow {
  private pending: {
    readonly draft: BroadcastModerationDraft;
    readonly snapshot: BroadcastModerationSnapshot;
    readonly confirmation: BroadcastModerationConfirmationView;
  } | null = null;
  private controller: AbortController | null = null;
  private conflict: string | null = null;
  private destroyed = false;

  constructor(
    private readonly actions: BroadcastModerationActionPort,
    private readonly ownSourceSafety: BroadcastOwnSourceSafetyPort,
    private readonly clock: () => number = Date.now,
    private readonly nonce: () => string = () => crypto.randomUUID().replaceAll("-", ""),
    private readonly timeoutMs = 10_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) fail("invalid_broadcast_moderation_timeout");
  }

  private assertAvailable(): void {
    if (this.destroyed) fail("broadcast_moderation_destroyed");
    if (this.controller) fail("broadcast_moderation_busy");
  }

  request(
    draftValue: BroadcastModerationDraft,
    snapshot: BroadcastModerationSnapshot,
    trigger: unknown,
  ): BroadcastModerationConfirmationView {
    if (trigger !== "user-action") fail("explicit_broadcast_moderation_action_required");
    this.assertAvailable();
    validateModerationSnapshot(snapshot);
    const draft = normalizeModerationDraft(draftValue);
    if (draft.action === "own-source-revoke" && draft.targetSubjectRef !== snapshot.actorSubjectRef) {
      fail("broadcast_own_source_required");
    }
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 120_000)) fail("invalid_broadcast_moderation_clock");
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
    this.assertAvailable();
    const pending = this.pending;
    this.pending = null;
    const now = this.clock();
    if (!pending) throw new BroadcastModerationWorkflowError("broadcast_moderation_confirmation_expired");
    if (!Number.isSafeInteger(now) || now < pending.confirmation.expiresAt - 120_000
      || pending.confirmation.confirmationId !== confirmationId
      || pending.confirmation.expiresAt <= now) fail("broadcast_moderation_confirmation_expired");
    const { draft, snapshot, confirmation } = pending;
    // Labels belong only to the local confirmation view, never the wire or audit.
    const { targetLabel: _localLabel, ...payload } = draft;
    const action: BroadcastModerationActionEnvelope = Object.freeze({
      ...payload,
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
    if (!/^bma_[A-Za-z0-9_-]{16,32}$/.test(action.actionId)) fail("invalid_broadcast_action_id");
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(new BroadcastModerationWorkflowError("broadcast_moderation_timeout")), this.timeoutMs);
    try {
      if (draft.action === "own-source-revoke") {
        if (!draft.sourceId) throw new BroadcastModerationWorkflowError("invalid_broadcast_source");
        await abortable(() => this.ownSourceSafety.fenceStopAndClear(draft.sourceId!, controller.signal), controller.signal);
      }
      const executionTime = this.clock();
      if (!Number.isSafeInteger(executionTime) || executionTime < now || executionTime >= confirmation.expiresAt) fail("broadcast_moderation_confirmation_expired");
      const received = await abortable(() => this.actions.execute(action, controller.signal), controller.signal);
      controller.signal.throwIfAborted();
      const result = normalizeModerationResult(received, snapshot);
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
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.pending = null;
    this.controller?.abort(new BroadcastModerationWorkflowError("broadcast_moderation_destroyed"));
    this.controller = null;
  }
}
