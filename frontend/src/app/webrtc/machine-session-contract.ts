export interface MachineSessionLease {
  readonly schema: "ananta.meet-session-lease.v1";
  readonly sessionId: string;
  readonly generation: number;
  readonly expiresAt: number;
  readonly absoluteExpiresAt: number;
}

export interface MachineSessionContext {
  readonly schema: "ananta.meet-machine-context.v1";
  readonly tenantId: string; readonly projectId: string; readonly taskId: string;
  readonly runtimeId: string; readonly hubSessionId: string;
}

export function parseMachineSessionContext(value: unknown): MachineSessionContext {
  const fields = ["schema", "tenantId", "projectId", "taskId", "runtimeId", "hubSessionId"];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("machine_context_invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || Object.keys(record).some(key => !fields.includes(key))
    || record["schema"] !== "ananta.meet-machine-context.v1"
    || fields.slice(1).some(key => typeof record[key] !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(String(record[key])))) {
    throw new Error("machine_context_invalid");
  }
  return Object.freeze({ ...record }) as unknown as MachineSessionContext;
}

export function parseMachineSessionLease(value: unknown, now = Date.now()): MachineSessionLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("machine_session_policy_invalid");
  const record = value as Record<string, unknown>;
  const keys = ["schema", "sessionId", "generation", "expiresAt", "absoluteExpiresAt"];
  if (Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key))
    || record["schema"] !== "ananta.meet-session-lease.v1"
    || typeof record["sessionId"] !== "string" || !/^ms_[A-Za-z0-9_-]{32}$/.test(record["sessionId"])
    || !["generation", "expiresAt", "absoluteExpiresAt"].every(key => Number.isSafeInteger(record[key]))
    || Number(record["generation"]) < 1 || Number(record["generation"]) > 512
    || Number(record["expiresAt"]) <= now || Number(record["expiresAt"]) > now + 600_000
    || Number(record["absoluteExpiresAt"]) < Number(record["expiresAt"])
    || Number(record["absoluteExpiresAt"]) > now + 7_200_000) throw new Error("machine_session_policy_invalid");
  return Object.freeze({ ...record }) as unknown as MachineSessionLease;
}
