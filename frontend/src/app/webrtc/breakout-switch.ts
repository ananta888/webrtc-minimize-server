const ASSIGNMENT_KEYS = Object.freeze([
  "version", "type", "grantId", "setId", "childRoomId", "parentRevision", "expiresAt",
]);
const PEER_ID = /^[a-f0-9]{16}$/;
const ROOM_ID = /^[a-z0-9][a-z0-9-]{5,47}$/;

export interface BreakoutAssignment {
  readonly grantId: string;
  readonly setId: string;
  readonly childRoomId: string;
  readonly parentRevision: number;
  readonly expiresAt: number;
}

export type BreakoutSwitchPhase = "idle" | "offered" | "switching" | "stranded";

export function parseBreakoutAssignment(message: { readonly type: string; readonly [key: string]: unknown }): BreakoutAssignment | null {
  if (message.type !== "breakout-assigned") return null;
  if (Object.keys(message).some((field) => !ASSIGNMENT_KEYS.includes(field))) return null;
  if (!PEER_ID.test(String(message["grantId"] || "")) || !PEER_ID.test(String(message["setId"] || ""))) return null;
  if (!ROOM_ID.test(String(message["childRoomId"] || ""))) return null;
  if (!Number.isSafeInteger(message["parentRevision"]) || Number(message["parentRevision"]) < 1) return null;
  if (!Number.isSafeInteger(message["expiresAt"]) || Number(message["expiresAt"]) < 1) return null;
  return Object.freeze({
    grantId: String(message["grantId"]),
    setId: String(message["setId"]),
    childRoomId: String(message["childRoomId"]),
    parentRevision: Number(message["parentRevision"]),
    expiresAt: Number(message["expiresAt"]),
  });
}

export function offerBreakoutSwitch(phase: BreakoutSwitchPhase, assignment: BreakoutAssignment | null, now: number): BreakoutSwitchPhase {
  if (!assignment || assignment.expiresAt <= now) return phase === "switching" ? "stranded" : "idle";
  if (phase === "switching" || phase === "stranded") return phase;
  return "offered";
}
