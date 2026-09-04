import { BroadcastProgramStateService } from "./broadcast-program-state.service";

export type BroadcastCockpitAudience = "private" | "unlisted" | "public";
export type BroadcastCockpitDelivery = "origin-llhls" | "cdn-hls" | "moq-experimental";

export interface BroadcastCockpitStartDraft {
  readonly tenantId: string;
  readonly roomId: string;
  readonly programId: string;
  readonly programEpoch: number;
  readonly sourceIds: readonly string[];
  readonly sourceLabels: readonly string[];
  readonly audience: BroadcastCockpitAudience;
  readonly layout: string;
  readonly audioProfile: string;
  readonly captionMode: "off" | "text-track" | "burn-in" | "text-track-and-burn-in";
  readonly deliveryProfile: BroadcastCockpitDelivery;
  readonly packagerRef: string;
  readonly qualityProfile: string;
  readonly estimatedUploadBitsPerSecond: number;
  readonly estimatedCpuClass: "low" | "medium" | "high";
}

export interface BroadcastCockpitConfirmation {
  readonly confirmationId: string;
  readonly audienceLabel: string;
  readonly sourceLabels: readonly string[];
  readonly trustSummary: string;
  readonly interruptionExpected: boolean;
  readonly expiresAt: number;
}

export interface BroadcastCockpitActionPort {
  start(draft: BroadcastCockpitStartDraft, signal: AbortSignal): Promise<void>;
  change(draft: BroadcastCockpitStartDraft, signal: AbortSignal): Promise<void>;
  stopPublication(reason: string): Promise<void>;
  revokeGrants(reason: string): Promise<void>;
  cleanupLocalSources(reason: string): Promise<void>;
}

const DRAFT_FIELDS = new Set([
  "tenantId", "roomId", "programId", "programEpoch", "sourceIds", "sourceLabels", "audience",
  "layout", "audioProfile", "captionMode", "deliveryProfile", "packagerRef", "qualityProfile",
  "estimatedUploadBitsPerSecond", "estimatedCpuClass",
]);
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:-]{2,127}$/;
const TENANT_ID = /^tn_[A-Za-z0-9_-]{16,64}$/;
const PROGRAM_ID = /^prg_[A-Za-z0-9_-]{16,64}$/;
const ROOM_ID = /^[a-z0-9][a-z0-9-]{5,47}$/;
const SOURCE_ID = /^src_[A-Za-z0-9_-]{16,64}$/;
const PACKAGER_REF = /^(brw|pkr)_[A-Za-z0-9_-]{16,64}$/;
const MAX_DRAFT_BYTES = 16 * 1024;

export class BroadcastCockpitWorkflowError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BroadcastCockpitWorkflowError";
  }
}

const fail = (code: string): never => { throw new BroadcastCockpitWorkflowError(code); };

function normalizeDraft(raw: BroadcastCockpitStartDraft): BroadcastCockpitStartDraft {
  let serialized: string;
  try { serialized = JSON.stringify(raw); } catch { return fail("invalid_broadcast_cockpit_draft"); }
  if (new TextEncoder().encode(serialized).byteLength > MAX_DRAFT_BYTES) {
    return fail("broadcast_cockpit_draft_too_large");
  }
  const value = JSON.parse(serialized) as BroadcastCockpitStartDraft;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((field) => !DRAFT_FIELDS.has(field))
    || !TENANT_ID.test(value.tenantId) || !ROOM_ID.test(value.roomId)
    || !PROGRAM_ID.test(value.programId) || !Number.isSafeInteger(value.programEpoch)
    || value.programEpoch < 1 || !Array.isArray(value.sourceIds) || value.sourceIds.length < 1
    || value.sourceIds.length > 4 || new Set(value.sourceIds).size !== value.sourceIds.length
    || value.sourceIds.some((id) => !SOURCE_ID.test(id))
    || !Array.isArray(value.sourceLabels) || value.sourceLabels.length !== value.sourceIds.length
    || value.sourceLabels.some((label) => typeof label !== "string" || label.length < 1 || label.length > 80)
    || !["private", "unlisted", "public"].includes(value.audience)
    || !IDENTIFIER.test(value.layout) || !IDENTIFIER.test(value.audioProfile)
    || !["off", "text-track", "burn-in", "text-track-and-burn-in"].includes(value.captionMode)
    || !["origin-llhls", "cdn-hls", "moq-experimental"].includes(value.deliveryProfile)
    || !PACKAGER_REF.test(value.packagerRef) || !IDENTIFIER.test(value.qualityProfile)
    || !Number.isFinite(value.estimatedUploadBitsPerSecond) || value.estimatedUploadBitsPerSecond < 0
    || value.estimatedUploadBitsPerSecond > 100_000_000
    || !["low", "medium", "high"].includes(value.estimatedCpuClass)) {
    return fail("invalid_broadcast_cockpit_draft");
  }
  if (value.deliveryProfile === "moq-experimental") fail("broadcast_moq_disabled");
  return Object.freeze({ ...value,
    sourceIds: Object.freeze([...value.sourceIds]),
    sourceLabels: Object.freeze([...value.sourceLabels]),
  });
}

export class BroadcastCockpitWorkflow {
  private pending: { confirmation: BroadcastCockpitConfirmation; draft: BroadcastCockpitStartDraft; kind: "start" | "change" } | null = null;
  private controller: AbortController | null = null;

  constructor(
    private readonly state: BroadcastProgramStateService,
    private readonly actions: BroadcastCockpitActionPort,
    private readonly clock: () => number = Date.now,
    private readonly nonce: () => string = () => crypto.randomUUID().replaceAll("-", ""),
  ) {}

  requestStart(raw: BroadcastCockpitStartDraft, trigger: unknown): BroadcastCockpitConfirmation {
    return this.request(raw, trigger, "start");
  }

  requestChange(raw: BroadcastCockpitStartDraft, trigger: unknown): BroadcastCockpitConfirmation {
    const lifecycle = this.state.value().lifecycle;
    if (!new Set(["running", "degraded", "reconnecting"]).has(lifecycle)) {
      fail("broadcast_change_requires_live_program");
    }
    return this.request(raw, trigger, "change");
  }

  cancelConfirmation(): void {
    this.pending = null;
  }

  async confirm(confirmationId: string, trigger: unknown): Promise<void> {
    if (trigger !== "user-action") fail("explicit_broadcast_confirmation_required");
    const pending = this.pending;
    this.pending = null;
    if (!pending) throw new BroadcastCockpitWorkflowError("broadcast_confirmation_expired");
    if (pending.confirmation.confirmationId !== confirmationId
      || pending.confirmation.expiresAt <= this.clock()) fail("broadcast_confirmation_expired");
    this.controller = new AbortController();
    try {
      if (pending.kind === "start") await this.actions.start(pending.draft, this.controller.signal);
      else {
        this.state.handingOver("broadcast_change_interrupts_playback");
        await this.actions.change(pending.draft, this.controller.signal);
        this.state.resumeRunning();
      }
    } catch (error) {
      this.state.failed(error instanceof Error && error.message ? error.message : "broadcast_action_failed");
      throw error;
    } finally {
      this.controller = null;
    }
  }

  async kill(trigger: unknown): Promise<void> {
    if (trigger !== "user-action") fail("explicit_broadcast_kill_required");
    this.pending = null;
    this.controller?.abort(new DOMException("kill", "AbortError"));
    this.state.stopping();
    const errors: unknown[] = [];
    for (const operation of [
      () => this.actions.stopPublication("kill-switch"),
      () => this.actions.revokeGrants("kill-switch"),
      () => this.actions.cleanupLocalSources("kill-switch"),
    ]) {
      try { await operation(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) {
      this.state.failed("broadcast_kill_cleanup_failed");
      throw errors[0];
    }
    this.state.stopped("broadcast_killed_by_user");
  }

  destroy(): void {
    this.pending = null;
    this.controller?.abort(new DOMException("destroy", "AbortError"));
    this.controller = null;
  }

  private request(raw: BroadcastCockpitStartDraft, trigger: unknown, kind: "start" | "change") {
    if (trigger !== "user-action") fail("explicit_broadcast_confirmation_required");
    const draft = normalizeDraft(raw);
    const now = this.clock();
    const confirmation = Object.freeze({
      confirmationId: `bcf_${this.nonce().slice(0, 32)}`,
      audienceLabel: { private: "Privat", unlisted: "Nicht gelistet", public: "Öffentlich" }[draft.audience],
      sourceLabels: draft.sourceLabels,
      trustSummary: `Trusted Packager ${draft.packagerRef}; Broadcast ist nicht Raum-SFrame-E2EE`,
      interruptionExpected: kind === "change",
      expiresAt: now + 120_000,
    });
    if (!/^bcf_[A-Za-z0-9_-]{16,32}$/.test(confirmation.confirmationId)) {
      fail("invalid_broadcast_confirmation_id");
    }
    this.pending = { confirmation, draft, kind };
    return confirmation;
  }
}
