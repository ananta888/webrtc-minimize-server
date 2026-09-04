import { Injectable } from "@angular/core";

import { OidcAuthService } from "../auth/oidc-auth.service";
import {
  BroadcastGrantProofContext,
  DeviceIdentityService,
  broadcastGrantProofMessage,
} from "../identity/device-identity.service";
import { BroadcastBrowserPortError, BroadcastProgramRef } from "./broadcast-ports";
import { parseBroadcastDirectoryEntry } from "./broadcast-directory.service";
import {
  WhipAuthorization,
  WhipAuthorizationPort,
  WhipAuthorizationRequest,
} from "./whip-contracts";

const PROGRAM = /^prg_[A-Za-z0-9_-]{16,64}$/;
const RESOURCE = /^res_[A-Za-z0-9_-]{16,64}$/;
const CHALLENGE = /^bpc_[A-Za-z0-9_-]{24,64}$/;
const SOURCE = /^src_[A-Za-z0-9_-]{16,64}$/;
const PACKAGER = /^pkr_[A-Za-z0-9_-]{16,64}$/;
const ASSIGNMENT = /^asn_[A-Za-z0-9_-]{16,64}$/;

export interface PreparedNativePackagerStart {
  readonly assignmentId: string;
  readonly packagerId: string;
  readonly programId: string;
  readonly programEpoch: number;
  readonly fencingRevision: number;
  readonly expiresAt: number;
}

async function json(response: Response, code: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new BroadcastBrowserPortError(code); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BroadcastBrowserPortError(code);
  }
  return value as Record<string, unknown>;
}

function requestError(response: Response, fallback: string): BroadcastBrowserPortError {
  if (response.status === 401) return new BroadcastBrowserPortError("broadcast_sign_in_required");
  if (response.status === 403) return new BroadcastBrowserPortError("broadcast_action_denied");
  if (response.status === 404) return new BroadcastBrowserPortError("broadcast_not_available");
  if (response.status === 409) return new BroadcastBrowserPortError("broadcast_state_conflict");
  if (response.status === 429) return new BroadcastBrowserPortError("broadcast_temporarily_unavailable");
  return new BroadcastBrowserPortError(fallback);
}

function programRef(value: unknown): BroadcastProgramRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BroadcastBrowserPortError("invalid_broadcast_program_response");
  }
  const program = value as Record<string, unknown>;
  if (Object.keys(program).length !== 5
    || !/^tn_[A-Za-z0-9_-]{16,64}$/.test(String(program["tenantId"] || ""))
    || !/^[a-z0-9][a-z0-9-]{5,47}$/.test(String(program["roomId"] || ""))
    || !PROGRAM.test(String(program["programId"] || ""))
    || !Number.isSafeInteger(program["programRevision"]) || Number(program["programRevision"]) < 1
    || !Number.isSafeInteger(program["programEpoch"]) || Number(program["programEpoch"]) < 1) {
    throw new BroadcastBrowserPortError("invalid_broadcast_program_response");
  }
  return Object.freeze({
    tenantId: String(program["tenantId"]),
    roomId: String(program["roomId"]),
    programId: String(program["programId"]),
    programRevision: Number(program["programRevision"]),
    programEpoch: Number(program["programEpoch"]),
  });
}

@Injectable({ providedIn: "root" })
export class BroadcastControlPlaneService implements WhipAuthorizationPort {
  private readonly sourceIds = new Map<string, readonly string[]>();
  private readonly preparedCreates = new Map<string, Readonly<{
    program: BroadcastProgramRef;
    authorization: WhipAuthorization;
  }>>();
  private readonly preparedNative = new Map<string, PreparedNativePackagerStart>();

  constructor(
    private readonly auth: OidcAuthService,
    private readonly device: DeviceIdentityService,
  ) {}

  async createProgram(
    roomId: string,
    title: string,
    visibility: "private" | "unlisted" | "public",
    signal: AbortSignal,
  ): Promise<BroadcastProgramRef> {
    const response = await fetch("/api/broadcasts", {
      method: "POST",
      headers: { "content-type": "application/json", ...this.auth.authorizationHeader() },
      credentials: "same-origin",
      redirect: "error",
      signal,
      body: JSON.stringify({ requestVersion: 1, roomId, title, visibility }),
    });
    if (!response.ok) throw requestError(response, "broadcast_program_create_failed");
    const value = await json(response, "invalid_broadcast_program_response");
    if (Object.keys(value).length !== 2 || !value["control"] || !value["program"]) {
      throw new BroadcastBrowserPortError("invalid_broadcast_program_response");
    }
    return programRef(value["control"]);
  }

  async prepareStart(
    program: BroadcastProgramRef,
    sourceIds: readonly string[],
    signal: AbortSignal,
  ): Promise<Readonly<{ program: BroadcastProgramRef; ownerSubjectRef: string }>> {
    if (!PROGRAM.test(program.programId) || !Array.isArray(sourceIds) || sourceIds.length < 1
      || sourceIds.length > 4 || new Set(sourceIds).size !== sourceIds.length
      || sourceIds.some((sourceId) => !SOURCE.test(sourceId))) {
      throw new BroadcastBrowserPortError("invalid_broadcast_publisher_sources");
    }
    this.sourceIds.set(program.programId, Object.freeze([...sourceIds]));
    const exchanged = await this.exchange({
      requestVersion: 1,
      program,
      action: "whip:create",
      resourceUrl: "https://publisher.invalid/authorized-by-control-plane",
    }, signal);
    this.preparedCreates.set(program.programId, Object.freeze({
      program: exchanged.program,
      authorization: exchanged.authorization,
    }));
    return Object.freeze({ program: exchanged.program, ownerSubjectRef: exchanged.subjectRef });
  }

  async prepareNativeStart(
    program: BroadcastProgramRef,
    sourceIds: readonly string[],
    packagerId: string,
    requestedRenditions: number,
    signal: AbortSignal,
  ): Promise<Readonly<{ program: BroadcastProgramRef; ownerSubjectRef: string }>> {
    const fingerprint = this.device.fingerprint();
    if (!PROGRAM.test(program.programId) || !PACKAGER.test(packagerId) || !fingerprint
      || !Array.isArray(sourceIds) || sourceIds.length < 1 || sourceIds.length > 4
      || new Set(sourceIds).size !== sourceIds.length || sourceIds.some((sourceId) => !SOURCE.test(sourceId))
      || !Number.isSafeInteger(requestedRenditions) || requestedRenditions < 1 || requestedRenditions > 3) {
      throw new BroadcastBrowserPortError("invalid_native_packager_publication_request");
    }
    const response = await fetch(`/api/broadcasts/${encodeURIComponent(program.programId)}/native-assignments`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.auth.authorizationHeader() },
      credentials: "same-origin",
      redirect: "error",
      signal,
      body: JSON.stringify({
        requestVersion: 1,
        trigger: "user-action",
        packagerId,
        sourceIds,
        requestedRenditions,
        allowHardwareAcceleration: true,
        deviceFingerprint: fingerprint,
      }),
    });
    if (!response.ok) throw requestError(response, "native_packager_assignment_failed");
    const value = await json(response, "invalid_native_packager_assignment_response");
    if (Object.keys(value).length !== 3 || !value["assignment"] || !value["program"]
      || !/^sub_[A-Za-z0-9_-]{16,64}$/.test(String(value["ownerSubjectRef"] || ""))) {
      throw new BroadcastBrowserPortError("invalid_native_packager_assignment_response");
    }
    const returnedProgram = programRef(value["program"]);
    const assignment = value["assignment"] as Record<string, unknown>;
    const assignmentFields = new Set([
      "assignmentId", "packagerId", "roomId", "programId", "programEpoch", "fencingRevision",
      "profileId", "renditionIds", "state", "reasonCode", "createdAt", "updatedAt", "expiresAt",
    ]);
    if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)
      || Object.keys(assignment).length !== assignmentFields.size
      || Object.keys(assignment).some((field) => !assignmentFields.has(field))
      || !ASSIGNMENT.test(String(assignment["assignmentId"] || ""))
      || assignment["packagerId"] !== packagerId || assignment["programId"] !== returnedProgram.programId
      || assignment["roomId"] !== returnedProgram.roomId
      || assignment["programEpoch"] !== returnedProgram.programEpoch
      || !Number.isSafeInteger(assignment["fencingRevision"]) || Number(assignment["fencingRevision"]) < 1
      || !Number.isSafeInteger(assignment["expiresAt"]) || Number(assignment["expiresAt"]) <= Date.now()) {
      throw new BroadcastBrowserPortError("invalid_native_packager_assignment_response");
    }
    this.preparedNative.set(returnedProgram.programId, Object.freeze({
      assignmentId: String(assignment["assignmentId"]),
      packagerId,
      programId: returnedProgram.programId,
      programEpoch: returnedProgram.programEpoch,
      fencingRevision: Number(assignment["fencingRevision"]),
      expiresAt: Number(assignment["expiresAt"]),
    }));
    return Object.freeze({ program: returnedProgram, ownerSubjectRef: String(value["ownerSubjectRef"]) });
  }

  takePreparedNative(program: BroadcastProgramRef): PreparedNativePackagerStart {
    const prepared = this.preparedNative.get(program.programId);
    this.preparedNative.delete(program.programId);
    if (!prepared || prepared.programEpoch !== program.programEpoch || prepared.expiresAt <= Date.now()) {
      throw new BroadcastBrowserPortError("native_packager_assignment_required");
    }
    return prepared;
  }

  async stopNativeAssignment(assignment: PreparedNativePackagerStart, signal: AbortSignal): Promise<void> {
    const response = await fetch(
      `/api/native-packagers/${encodeURIComponent(assignment.packagerId)}/assignments/${encodeURIComponent(assignment.assignmentId)}`,
      { method: "DELETE", headers: this.auth.authorizationHeader(), credentials: "same-origin", redirect: "error", signal },
    );
    if (!response.ok) throw requestError(response, "native_packager_assignment_stop_failed");
  }

  async authorize(request: WhipAuthorizationRequest, signal: AbortSignal): Promise<WhipAuthorization> {
    signal.throwIfAborted();
    if (request.action === "whip:create") {
      const prepared = this.preparedCreates.get(request.program.programId);
      this.preparedCreates.delete(request.program.programId);
      if (!prepared || prepared.program.programRevision !== request.program.programRevision
        || prepared.program.programEpoch !== request.program.programEpoch
        || prepared.authorization.expiresAt <= Date.now() + 1_000) {
        throw new BroadcastBrowserPortError("broadcast_start_authorization_required");
      }
      return prepared.authorization;
    }
    return (await this.exchange(request, signal)).authorization;
  }

  async changeVisibility(
    programId: string,
    visibility: "private" | "unlisted" | "public",
    signal: AbortSignal,
  ): Promise<void> {
    if (!PROGRAM.test(programId) || !new Set(["private", "unlisted", "public"]).has(visibility)) {
      throw new BroadcastBrowserPortError("invalid_broadcast_visibility_request");
    }
    const response = await fetch(`/api/broadcasts/${encodeURIComponent(programId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...this.auth.authorizationHeader() },
      credentials: "same-origin",
      redirect: "error",
      signal,
      body: JSON.stringify({ requestVersion: 1, visibility }),
    });
    if (!response.ok) throw requestError(response, "broadcast_visibility_update_failed");
    const value = await json(response, "invalid_broadcast_visibility_response");
    if (Object.keys(value).length !== 1 || !value["program"] || typeof value["program"] !== "object") {
      throw new BroadcastBrowserPortError("invalid_broadcast_visibility_response");
    }
    parseBroadcastDirectoryEntry(value["program"]);
  }

  async stopProgram(programId: string, signal: AbortSignal): Promise<void> {
    if (!PROGRAM.test(programId)) throw new BroadcastBrowserPortError("invalid_broadcast_program");
    const response = await fetch(`/api/broadcasts/${encodeURIComponent(programId)}`, {
      method: "DELETE",
      headers: this.auth.authorizationHeader(),
      credentials: "same-origin",
      redirect: "error",
      signal,
    });
    if (!response.ok) throw requestError(response, "broadcast_program_stop_failed");
    const value = await json(response, "invalid_broadcast_stop_response");
    if (Object.keys(value).length !== 1 || !value["program"] || typeof value["program"] !== "object") {
      throw new BroadcastBrowserPortError("invalid_broadcast_stop_response");
    }
    parseBroadcastDirectoryEntry(value["program"]);
    this.clear(programId);
  }

  private async exchange(
    request: WhipAuthorizationRequest,
    signal: AbortSignal,
  ): Promise<Readonly<{
    authorization: WhipAuthorization;
    program: BroadcastProgramRef;
    subjectRef: string;
  }>> {
    const sourceIds = this.sourceIds.get(request.program.programId);
    const fingerprint = this.device.fingerprint();
    if (!sourceIds || !fingerprint) {
      throw new BroadcastBrowserPortError("broadcast_active_device_required");
    }
    const challengeResponse = await fetch(
      `/api/broadcasts/${encodeURIComponent(request.program.programId)}/publisher-challenges`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.auth.authorizationHeader() },
        credentials: "same-origin",
        redirect: "error",
        signal,
        body: JSON.stringify({
          requestVersion: 1,
          action: request.action,
          sourceIds,
          deviceFingerprint: fingerprint,
        }),
      },
    );
    if (!challengeResponse.ok) throw requestError(challengeResponse, "broadcast_publisher_challenge_failed");
    const challenge = await json(challengeResponse, "invalid_broadcast_publisher_challenge");
    if (Object.keys(challenge).length !== 4 || challenge["challengeVersion"] !== 1
      || !CHALLENGE.test(String(challenge["challengeId"] || ""))
      || !Number.isSafeInteger(challenge["expiresAt"]) || Number(challenge["expiresAt"]) <= Date.now()
      || !challenge["proofContext"] || typeof challenge["proofContext"] !== "object"
      || Array.isArray(challenge["proofContext"])) {
      throw new BroadcastBrowserPortError("invalid_broadcast_publisher_challenge");
    }
    const proofContext = challenge["proofContext"] as BroadcastGrantProofContext;
    broadcastGrantProofMessage(proofContext, Date.now(), "validation-nonce-123456");
    if (proofContext.programId !== request.program.programId
      || proofContext.grantKind !== "publisher"
      || proofContext.actions.length !== 1 || proofContext.actions[0] !== request.action) {
      throw new BroadcastBrowserPortError("invalid_broadcast_publisher_challenge");
    }
    const deviceProof = await this.device.createBroadcastGrantProof(proofContext);
    signal.throwIfAborted();
    const authorizationResponse = await fetch(
      `/api/broadcasts/${encodeURIComponent(request.program.programId)}/publisher-authorizations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.auth.authorizationHeader() },
        credentials: "same-origin",
        redirect: "error",
        signal,
        body: JSON.stringify({ requestVersion: 1, challengeId: challenge["challengeId"], deviceProof }),
      },
    );
    if (!authorizationResponse.ok) {
      throw requestError(authorizationResponse, "broadcast_publisher_authorization_failed");
    }
    const authorization = await json(authorizationResponse, "invalid_broadcast_publisher_authorization");
    const fields = new Set([
      "authorizationVersion", "accessToken", "expiresAt", "program", "resourceRef", "resourceUrl",
    ]);
    if (Object.keys(authorization).some((field) => !fields.has(field))
      || authorization["authorizationVersion"] !== 1
      || typeof authorization["accessToken"] !== "string"
      || authorization["accessToken"].length < 16 || authorization["accessToken"].length > 8 * 1024
      || !Number.isSafeInteger(authorization["expiresAt"])
      || Number(authorization["expiresAt"]) <= Date.now() + 1_000
      || !RESOURCE.test(String(authorization["resourceRef"] || ""))
      || (request.action === "whip:create" && typeof authorization["resourceUrl"] !== "string")
      || (request.action !== "whip:create" && authorization["resourceUrl"] !== undefined)) {
      throw new BroadcastBrowserPortError("invalid_broadcast_publisher_authorization");
    }
    const returnedProgram = programRef(authorization["program"]);
    if (returnedProgram.programId !== request.program.programId
      || returnedProgram.roomId !== request.program.roomId
      || returnedProgram.tenantId !== request.program.tenantId) {
      throw new BroadcastBrowserPortError("invalid_broadcast_publisher_authorization");
    }
    const normalizedAuthorization = Object.freeze({
      authorizationVersion: 1,
      accessToken: String(authorization["accessToken"]),
      expiresAt: Number(authorization["expiresAt"]),
      ...(authorization["resourceUrl"] === undefined ? {} : {
        resourceUrl: String(authorization["resourceUrl"]),
      }),
    });
    return Object.freeze({
      authorization: normalizedAuthorization,
      program: returnedProgram,
      subjectRef: proofContext.subjectRef,
    });
  }

  clear(programId?: string): void {
    if (programId) {
      this.sourceIds.delete(programId);
      this.preparedCreates.delete(programId);
      this.preparedNative.delete(programId);
    } else {
      this.sourceIds.clear();
      this.preparedCreates.clear();
      this.preparedNative.clear();
    }
  }
}
