import type { BroadcastModerationDraft, BroadcastModerationResult, BroadcastModerationSnapshot } from "./broadcast-moderation-workflow";

const FIELDS: Record<string, readonly string[]> = Object.freeze({
  "source-request": ["targetSubjectRef", "sourceKind"],
  "source-remove": ["targetSubjectRef", "sourceId", "reasonCode"],
  "own-source-revoke": ["targetSubjectRef", "sourceId", "reasonCode"],
  "layout-change": ["layout"],
  "packager-select": ["primaryAgentId", "standbyAgentIds"],
  "packager-standby": ["standbyAgentIds"],
  "packager-handoff": ["primaryAgentId"],
  "program-stop": ["reasonCode"],
});
const LAYOUTS = ["single", "screen-presenter", "side-by-side", "active-speaker", "grid", "waiting-slate", "end-slate"];
const ROLES = ["owner", "moderator", "presenter", "packager", "viewer"];
const SUBJECT = /^sub_[A-Za-z0-9_-]{16,64}$/;
const AGENT = /^(?:pkr_[A-Za-z0-9_-]{16,64}|[a-z0-9][a-z0-9-]{0,31})$/;

export class BroadcastModerationWorkflowError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BroadcastModerationWorkflowError"; }
}
function fail(code: string): never { throw new BroadcastModerationWorkflowError(code); }
const pattern = (value: unknown, expression: RegExp): boolean => typeof value === "string" && expression.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function closed(value: unknown, fields: readonly string[], code: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail(code);
}

export function normalizeModerationDraft(value: unknown): BroadcastModerationDraft {
  const action = (value as BroadcastModerationDraft | null)?.action;
  if (typeof action !== "string" || !Object.hasOwn(FIELDS, action)) fail("invalid_broadcast_moderation_draft");
  closed(value, ["action", "targetLabel", ...FIELDS[action]], "invalid_broadcast_moderation_draft");
  const { targetLabel, targetSubjectRef, sourceId, reasonCode, sourceKind, layout, primaryAgentId, standbyAgentIds } = value;
  if (typeof targetLabel !== "string" || targetLabel.length < 1 || targetLabel.length > 80) fail("invalid_broadcast_moderation_draft");
  if ("targetSubjectRef" in value && !pattern(targetSubjectRef, SUBJECT)) fail("invalid_broadcast_subject");
  if ("sourceId" in value && !pattern(sourceId, /^src_[A-Za-z0-9_-]{16,64}$/)) fail("invalid_broadcast_source");
  if ("reasonCode" in value && !pattern(reasonCode, /^[A-Z][A-Z0-9_]{1,31}$/)) fail("invalid_broadcast_reason");
  if ("sourceKind" in value && !["microphone", "camera", "screen", "screen-audio"].includes(sourceKind as string)) fail("invalid_broadcast_source_request");
  if ("layout" in value && !LAYOUTS.includes(layout as string)) fail("invalid_broadcast_layout");
  if ("primaryAgentId" in value && !pattern(primaryAgentId, AGENT)) fail("invalid_broadcast_packager_selection");
  if ("standbyAgentIds" in value && (!Array.isArray(standbyAgentIds) || standbyAgentIds.length > 2
    || [...standbyAgentIds].some(id => !pattern(id, AGENT)) || new Set(standbyAgentIds).size !== standbyAgentIds.length
    || standbyAgentIds.includes(primaryAgentId))) fail("invalid_broadcast_packager_selection");
  const clone = { ...value, ...("standbyAgentIds" in value ? { standbyAgentIds: Object.freeze([...(standbyAgentIds as string[])]) } : {}) };
  if (new TextEncoder().encode(JSON.stringify(clone)).byteLength > 8 * 1024) fail("invalid_broadcast_moderation_draft");
  return Object.freeze(clone) as unknown as BroadcastModerationDraft;
}

export function validateModerationSnapshot(value: unknown): asserts value is BroadcastModerationSnapshot {
  closed(value, ["tenantId", "roomId", "programId", "programRevision", "programEpoch", "leaseEpoch", "actorSubjectRef", "actorRole"], "invalid_broadcast_moderation_snapshot");
  const { tenantId, roomId, programId, actorSubjectRef, programRevision, programEpoch, leaseEpoch, actorRole } = value;
  if (!pattern(tenantId, /^tn_[A-Za-z0-9_-]{16,64}$/) || !pattern(roomId, /^[a-z0-9][a-z0-9-]{5,47}$/)
    || !pattern(programId, /^prg_[A-Za-z0-9_-]{16,64}$/) || !pattern(actorSubjectRef, SUBJECT)
    || !positive(programRevision) || !positive(programEpoch) || !positive(leaseEpoch)
    || !ROLES.includes(actorRole as string)) fail("invalid_broadcast_moderation_snapshot");
}

export function normalizeModerationResult(value: unknown, before: BroadcastModerationSnapshot): BroadcastModerationResult {
  closed(value, ["programRevision", "programEpoch", "leaseEpoch"], "invalid_broadcast_moderation_result");
  const { programRevision, programEpoch, leaseEpoch } = value;
  if (!positive(programRevision) || !positive(programEpoch) || !positive(leaseEpoch)
    || programRevision < before.programRevision || programEpoch < before.programEpoch
    || leaseEpoch < before.leaseEpoch) fail("invalid_broadcast_moderation_result");
  return Object.freeze({ programRevision, programEpoch, leaseEpoch });
}
