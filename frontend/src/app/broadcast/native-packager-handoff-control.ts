import { BroadcastBrowserPortError } from "./broadcast-ports";

export interface NativePackagerHandoffControl {
  readonly controlVersion: 1;
  readonly programId: string;
  readonly programRevision: number;
  readonly programEpoch: number;
  readonly state: string;
  readonly handoffPending: boolean;
  readonly writer: Readonly<{ packagerId: string; fencingRevision: number }> | null;
}

const fields = new Set(["controlVersion", "programId", "programRevision", "programEpoch", "state", "handoffPending", "writer"]);
const states = new Set(["draft", "preparing", "awaiting_consent", "publishing", "live", "degraded", "stopping", "stopped", "failed"]);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

export function parseNativeHandoffControl(value: unknown, programId: string): NativePackagerHandoffControl {
  const fail = (): never => { throw new BroadcastBrowserPortError("invalid_native_handoff_control"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== fields.size || Object.keys(item).some((field) => !fields.has(field))
    || item["controlVersion"] !== 1 || item["programId"] !== programId
    || !/^prg_[A-Za-z0-9_-]{16,64}$/.test(programId)
    || !positive(item["programRevision"]) || !positive(item["programEpoch"])
    || typeof item["state"] !== "string" || !states.has(item["state"])
    || typeof item["handoffPending"] !== "boolean") return fail();
  const writer = item["writer"] as Record<string, unknown> | null;
  if (writer !== null && (!writer || typeof writer !== "object" || Array.isArray(writer)
    || Object.keys(writer).length !== 2 || typeof writer["packagerId"] !== "string"
    || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(writer["packagerId"])
    || !positive(writer["fencingRevision"]))) return fail();
  return Object.freeze({
    controlVersion: 1, programId, programRevision: item["programRevision"], programEpoch: item["programEpoch"],
    state: item["state"], handoffPending: item["handoffPending"],
    writer: writer === null ? null : Object.freeze({
      packagerId: writer["packagerId"] as string, fencingRevision: writer["fencingRevision"] as number,
    }),
  });
}
