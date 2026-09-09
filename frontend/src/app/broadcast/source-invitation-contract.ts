import type { BroadcastSourceKind } from "./broadcast-ports";

export interface SourceInvitation {
  readonly requestId: string; readonly roomId: string; readonly programId: string;
  readonly programRevision: number; readonly programEpoch: number;
  readonly ownerPeerId: string; readonly targetPeerId: string; readonly packagerRef: string;
  readonly sourceKind: BroadcastSourceKind; readonly state: "pending" | "declined" | "cancelled" | "invalidated";
  readonly createdAt: number; readonly expiresAt: number; readonly authority: "none";
}
export interface SourceRequestProgram { readonly programId: string; readonly programRevision: number; readonly programEpoch: number }
export const SOURCE_REQUEST_KINDS = Object.freeze(["microphone", "camera", "screen", "screen-audio"] as const);
export const sourceInvitationFields = Object.freeze(["requestId", "roomId", "programId", "programRevision", "programEpoch", "ownerPeerId", "targetPeerId",
  "packagerRef", "sourceKind", "state", "createdAt", "expiresAt", "authority"]);
const peer = /^[a-f0-9]{16}$/;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const fail = (): never => { throw new Error("invalid_source_invitation_response"); };

export function parseSourceInvitations(raw: unknown, roomId: string, peerId: string, now = Date.now()): readonly SourceInvitation[] {
  const response = raw as { responseVersion?: unknown; requests?: unknown } | null;
  if (!response || Object.keys(response).sort().join() !== "requests,responseVersion" || response.responseVersion !== 1
    || !Array.isArray(response.requests) || response.requests.length > 40 || !peer.test(peerId)) return fail();
  const ids = new Set<string>();
  return Object.freeze(response.requests.map((raw: unknown) => {
    const value = raw as SourceInvitation;
    if (!value || typeof value !== "object" || Object.keys(value).length !== sourceInvitationFields.length
      || Object.keys(value).some(key => !sourceInvitationFields.includes(key)) || value.roomId !== roomId
      || typeof value.requestId !== "string" || !/^bsr_[A-Za-z0-9_-]{24}$/.test(value.requestId) || ids.has(value.requestId)
      || typeof value.programId !== "string" || !/^prg_[A-Za-z0-9_-]{16,64}$/.test(value.programId)
      || !positive(value.programRevision) || !positive(value.programEpoch)
      || typeof value.packagerRef !== "string" || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(value.packagerRef)
      || typeof value.ownerPeerId !== "string" || typeof value.targetPeerId !== "string"
      || !peer.test(value.ownerPeerId) || !peer.test(value.targetPeerId)
      || (value.ownerPeerId !== peerId && value.targetPeerId !== peerId)
      || !SOURCE_REQUEST_KINDS.includes(value.sourceKind)
      || !["pending", "declined", "cancelled", "invalidated"].includes(value.state) || value.authority !== "none"
      || !positive(value.createdAt) || !positive(value.expiresAt) || value.expiresAt <= value.createdAt
      || value.expiresAt - value.createdAt > 120_000 || value.createdAt > now + 5000) return fail();
    ids.add(value.requestId); return Object.freeze({ ...value });
  }));
}
