import {
  BroadcastBrowserPortError,
  BroadcastPlaybackRequest,
  BroadcastStartPlan,
} from "./broadcast-ports";

const TENANT_ID = /^tn_[A-Za-z0-9_-]{16,64}$/;
const ROOM_ID = /^[a-z0-9][a-z0-9-]{5,47}$/;
const PROGRAM_ID = /^prg_[A-Za-z0-9_-]{16,64}$/;
const SOURCE_ID = /^src_[A-Za-z0-9_-]{16,64}$/;
const SUBJECT_REF = /^sub_[A-Za-z0-9_-]{16,64}$/;
const SESSION_INSTANCE = /^[A-Za-z0-9_-]{16,128}$/;
const ADAPTER_ID = /^[a-z][a-z0-9-]{2,63}$/;
const SOURCE_KINDS = new Set(["microphone", "camera", "screen", "screen-audio"]);
const MAX_PLAN_BYTES = 64 * 1024;

function clone(value: unknown, code: string): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MAX_PLAN_BYTES) {
      throw new BroadcastBrowserPortError(code);
    }
    return JSON.parse(serialized) as unknown;
  } catch (error) {
    if (error instanceof BroadcastBrowserPortError) throw error;
    throw new BroadcastBrowserPortError(code);
  }
}

function object(value: unknown, fields: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BroadcastBrowserPortError(code);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length
    || Object.keys(record).some((field) => !fields.includes(field))) {
    throw new BroadcastBrowserPortError(code);
  }
  return record;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new BroadcastBrowserPortError(code);
  return Number(value);
}

function string(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new BroadcastBrowserPortError(code);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function normalizeBroadcastStartPlan(value: unknown): BroadcastStartPlan {
  const plan = object(clone(value, "invalid_broadcast_start_plan"), [
    "planVersion", "trigger", "program", "roomPublication", "sourceIds", "adapterId",
  ], "invalid_broadcast_start_plan");
  const program = object(plan["program"], [
    "tenantId", "roomId", "programId", "programRevision", "programEpoch",
  ], "invalid_broadcast_start_plan");
  const publication = object(plan["roomPublication"], [
    "snapshotVersion", "sessionInstanceId", "roomId", "publicationRevision", "sources",
  ], "invalid_broadcast_start_plan");
  if (plan["planVersion"] !== 1 || plan["trigger"] !== "user-action") {
    throw new BroadcastBrowserPortError("explicit_broadcast_start_required");
  }
  if (publication["snapshotVersion"] !== 1
    || publication["roomId"] !== program["roomId"]
    || !Array.isArray(plan["sourceIds"]) || plan["sourceIds"].length < 1
    || plan["sourceIds"].length > 20 || new Set(plan["sourceIds"]).size !== plan["sourceIds"].length
    || !Array.isArray(publication["sources"]) || publication["sources"].length > 20) {
    throw new BroadcastBrowserPortError("invalid_broadcast_start_plan");
  }
  const sources = publication["sources"].map((candidate) => {
    const source = object(candidate, ["sourceId", "ownerSubjectRef", "kind", "local", "active"],
      "invalid_broadcast_start_plan");
    if (!SOURCE_KINDS.has(String(source["kind"]))
      || typeof source["local"] !== "boolean" || typeof source["active"] !== "boolean") {
      throw new BroadcastBrowserPortError("invalid_broadcast_start_plan");
    }
    return {
      sourceId: string(source["sourceId"], SOURCE_ID, "invalid_broadcast_start_plan"),
      ownerSubjectRef: string(source["ownerSubjectRef"], SUBJECT_REF, "invalid_broadcast_start_plan"),
      kind: source["kind"],
      local: source["local"],
      active: source["active"],
    };
  });
  if (new Set(sources.map(({ sourceId }) => sourceId)).size !== sources.length
    || plan["sourceIds"].some((sourceId) => typeof sourceId !== "string" || !SOURCE_ID.test(sourceId))) {
    throw new BroadcastBrowserPortError("invalid_broadcast_start_plan");
  }
  return deepFreeze({
    planVersion: 1,
    trigger: "user-action",
    program: {
      tenantId: string(program["tenantId"], TENANT_ID, "invalid_broadcast_start_plan"),
      roomId: string(program["roomId"], ROOM_ID, "invalid_broadcast_start_plan"),
      programId: string(program["programId"], PROGRAM_ID, "invalid_broadcast_start_plan"),
      programRevision: positiveInteger(program["programRevision"], "invalid_broadcast_start_plan"),
      programEpoch: positiveInteger(program["programEpoch"], "invalid_broadcast_start_plan"),
    },
    roomPublication: {
      snapshotVersion: 1,
      sessionInstanceId: string(
        publication["sessionInstanceId"],
        SESSION_INSTANCE,
        "invalid_broadcast_start_plan",
      ),
      roomId: String(publication["roomId"]),
      publicationRevision: positiveInteger(
        publication["publicationRevision"],
        "invalid_broadcast_start_plan",
      ),
      sources,
    },
    sourceIds: [...plan["sourceIds"]] as string[],
    adapterId: string(plan["adapterId"], ADAPTER_ID, "invalid_broadcast_start_plan"),
  } as BroadcastStartPlan);
}

export function normalizeBroadcastPlaybackRequest(value: unknown): BroadcastPlaybackRequest {
  const request = object(clone(value, "invalid_broadcast_playback_request"), [
    "requestVersion", "trigger", "programId", "programEpoch", "policyRevision",
  ], "invalid_broadcast_playback_request");
  if (request["requestVersion"] !== 1 || request["trigger"] !== "user-action") {
    throw new BroadcastBrowserPortError("explicit_broadcast_playback_required");
  }
  return deepFreeze({
    requestVersion: 1,
    trigger: "user-action",
    programId: string(request["programId"], PROGRAM_ID, "invalid_broadcast_playback_request"),
    programEpoch: positiveInteger(request["programEpoch"], "invalid_broadcast_playback_request"),
    policyRevision: positiveInteger(request["policyRevision"], "invalid_broadcast_playback_request"),
  });
}
