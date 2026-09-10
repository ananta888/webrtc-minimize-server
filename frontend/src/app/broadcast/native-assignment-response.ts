import { BroadcastBrowserPortError, BroadcastProgramRef } from "./broadcast-ports";
const ASSIGNMENT = /^asn_[A-Za-z0-9_-]{16,64}$/;

/** Closed response parser; no storage, identity, network or source authority. */
export function parseNativeAssignmentResponse(value: Record<string, unknown>, program: BroadcastProgramRef,
  packagerId: string, previousFence: number | undefined, expectedInputMode: "trusted-sframe-v1" | undefined,
  readProgram: (value: unknown) => BroadcastProgramRef) {
    if (Object.keys(value).length !== 3 || !value["assignment"] || !value["program"]
      || typeof value["ownerSubjectRef"] !== "string"
      || !/^sub_[A-Za-z0-9_-]{16,64}$/.test(String(value["ownerSubjectRef"] || ""))) {
      throw new BroadcastBrowserPortError("invalid_native_packager_assignment_response");
    }
    const returnedProgram = readProgram(value["program"]);
    if (returnedProgram.programId !== program.programId || returnedProgram.roomId !== program.roomId
      || returnedProgram.tenantId !== program.tenantId || returnedProgram.programRevision <= program.programRevision
      // Only source starts retain the epoch; every handoff requires the next epoch.
      || returnedProgram.programEpoch !== program.programEpoch + (expectedInputMode && previousFence === undefined ? 0 : 1)) {
      throw new BroadcastBrowserPortError("invalid_native_packager_assignment_response");
    }
    const assignment = value["assignment"] as Record<string, unknown>;
    const assignmentFields = new Set([
      "assignmentId", "packagerId", "roomId", "programId", "programEpoch", "fencingRevision",
      "profileId", "renditionIds", "state", "reasonCode", "createdAt", "updatedAt", "expiresAt",
      ...(expectedInputMode ? ["inputMode"] : []),
    ]);
    if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)
      || Object.keys(assignment).length !== assignmentFields.size
      || Object.keys(assignment).some((field) => !assignmentFields.has(field))
      || (expectedInputMode !== undefined && assignment["inputMode"] !== expectedInputMode)
      || typeof assignment["assignmentId"] !== "string"
      || !ASSIGNMENT.test(String(assignment["assignmentId"] || ""))
      || assignment["packagerId"] !== packagerId || assignment["programId"] !== returnedProgram.programId
      || assignment["roomId"] !== returnedProgram.roomId
      || assignment["programEpoch"] !== returnedProgram.programEpoch
      || !Number.isSafeInteger(assignment["fencingRevision"]) || Number(assignment["fencingRevision"]) < 1
      || (previousFence !== undefined && Number(assignment["fencingRevision"]) <= previousFence)
      || assignment["profileId"] !== "h264-aac-720p-v1"
      || !Array.isArray(assignment["renditionIds"]) || assignment["renditionIds"].length < 1
      || assignment["renditionIds"].length > 3 || new Set(assignment["renditionIds"]).size !== assignment["renditionIds"].length
      || assignment["renditionIds"].some((id) => typeof id !== "string" || !["low", "medium", "high"].includes(id))
      || assignment["state"] !== "preparing" || assignment["reasonCode"] !== "AWAITING_AGENT"
      || !Number.isSafeInteger(assignment["createdAt"]) || Number(assignment["createdAt"]) <= 0
      || !Number.isSafeInteger(assignment["updatedAt"]) || Number(assignment["updatedAt"]) < Number(assignment["createdAt"])
      || !Number.isSafeInteger(assignment["expiresAt"]) || Number(assignment["expiresAt"]) <= Date.now()) {
      throw new BroadcastBrowserPortError("invalid_native_packager_assignment_response");
    }
    const prepared = Object.freeze({
      assignmentId: String(assignment["assignmentId"]),
      packagerId,
      programId: returnedProgram.programId,
      programEpoch: returnedProgram.programEpoch,
      fencingRevision: Number(assignment["fencingRevision"]),
      expiresAt: Number(assignment["expiresAt"]),
    });
    return Object.freeze({ program: returnedProgram, ownerSubjectRef: String(value["ownerSubjectRef"]), assignment: prepared });
}
