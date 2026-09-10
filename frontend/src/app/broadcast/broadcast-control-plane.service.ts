import { Injectable } from "@angular/core";

import { OidcAuthService } from "../auth/oidc-auth.service";
import {
  BroadcastGrantProofContext,
  DeviceIdentityService,
  broadcastGrantProofMessage,
} from "../identity/device-identity.service";
import { BroadcastBrowserPortError, BroadcastProgramRef } from "./broadcast-ports";
import { parseBroadcastDirectoryEntry } from "./broadcast-directory.service";
import type { NativePackagerHandoffControl } from "./native-packager-handoff-control";
import type { NativeSceneResult, NativeSceneSelection, NativeSceneState } from "./native-source-scene-contract";
import type { NativeSourceLabels } from "./native-source-labels-contract";
import type { NativeAudioResult, NativeAudioSelection } from "./native-source-audio-contract";
import type { NativeSourceAudioOutput } from "./native-source-audio-output";
import type { NativeSourceVideoOutput } from "./native-source-video-output";
import {
  WhipAuthorization,
  WhipAuthorizationPort,
  WhipAuthorizationRequest,
} from "./whip-contracts";

const PROGRAM = /^prg_[A-Za-z0-9_-]{16,64}$/;
const RESOURCE = /^res_[A-Za-z0-9_-]{16,64}$/;
const CHALLENGE = /^bpc_[A-Za-z0-9_-]{24,64}$/;
const SOURCE = /^src_[A-Za-z0-9_-]{16,64}$/;
const TERMINAL_ASSIGNMENT_STATES = new Set(["stopped", "failed"]);
const NATIVE_STOP_CONFIRMATION_MS = 12_000;

export interface PreparedNativePackagerStart {
  readonly assignmentId: string;
  readonly packagerId: string;
  readonly programId: string;
  readonly programEpoch: number;
  readonly fencingRevision: number;
  readonly expiresAt: number;
}

async function json(response: Response, code: string, maximumBytes?: number): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    if (maximumBytes !== undefined) {
      if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json" || !response.body) throw new Error();
      const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0, body = "", complete = false;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) { complete = true; break; }
          bytes += result.value.byteLength;
          if (bytes > maximumBytes) throw new Error();
          body += decoder.decode(result.value, { stream: true });
        }
        value = JSON.parse(body + decoder.decode());
      } finally { if (!complete) void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    } else value = await response.json();
  } catch { throw new BroadcastBrowserPortError(code); }
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

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(finish, delayMs);
    const abort = () => finish(signal.reason || new DOMException("Aborted", "AbortError"));
    function finish(error?: unknown): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
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
    const value = await json(response, "invalid_broadcast_program_response", 16384);
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
    signal.throwIfAborted();
    program = { ...program };
    sourceIds = Array.isArray(sourceIds) ? [...sourceIds] : sourceIds;
    const { requestNativePublicationStart } = await import("./native-publication-start-http");
    signal.throwIfAborted();
    const response = await requestNativePublicationStart(program, sourceIds, packagerId, requestedRenditions, signal, {
      fingerprint: () => this.device.fingerprint(), authorizationHeader: () => this.auth.authorizationHeader(),
    });
    if (!response.ok) throw requestError(response, "native_packager_assignment_failed");
    return this.acceptNativeAssignment(response, program, packagerId, signal);
  }

  async nativeHandoffControl(programId: string, signal: AbortSignal): Promise<NativePackagerHandoffControl> {
    signal.throwIfAborted();
    const { requestNativeHandoffControl } = await import("./native-handoff-control-http");
    signal.throwIfAborted();
    return requestNativeHandoffControl(programId, signal, {
      fingerprint: () => this.device.fingerprint(), authorizationHeader: () => this.auth.authorizationHeader(),
      readJson: json, responseError: requestError,
    });
  }

  async nativeSourceScene(program: BroadcastProgramRef, selection: NativeSceneSelection | null, signal: AbortSignal): Promise<NativeSceneResult> {
    signal.throwIfAborted();
    const { requestNativeSourceScene } = await import("./native-source-scene-http");
    signal.throwIfAborted();
    return requestNativeSourceScene(program, selection, signal, {
      fingerprint: () => this.device.fingerprint(), authorizationHeader: () => this.auth.authorizationHeader(),
      readJson: json, responseError: requestError,
    });
  }

  async nativeSourceLabels(scene: NativeSceneState, signal: AbortSignal): Promise<NativeSourceLabels> {
    signal.throwIfAborted();
    const { requestNativeSourceLabels } = await import("./native-source-labels-http");
    signal.throwIfAborted();
    return requestNativeSourceLabels(scene, signal, {
      fingerprint: () => this.device.fingerprint(), authorizationHeader: () => this.auth.authorizationHeader(),
      readJson: json, responseError: requestError,
    });
  }

  async nativeSourceAudio(program: BroadcastProgramRef, selection: NativeAudioSelection | null, signal: AbortSignal, version: 1 | 2 | 3 = 1): Promise<NativeAudioResult> {
    signal.throwIfAborted();
    const { requestNativeSourceAudio } = await import("./native-source-audio-http");
    signal.throwIfAborted();
    return requestNativeSourceAudio(program, selection, signal, {
      fingerprint: () => this.device.fingerprint(), authorizationHeader: () => this.auth.authorizationHeader(),
      readJson: json, responseError: requestError,
    }, version);
  }

  /** Explicit source entry: no local media, legacy ingress or source consent is implied. */
  async nativeCapacityPreview(request: import("./native-source-program-controller").NativeSourceProgramRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    const { requestNativeCapacityPreview } = await import("./native-capacity-preview");
    return requestNativeCapacityPreview(request, signal, {
      fingerprint: () => this.device.fingerprint(), authorizationHeader: () => this.auth.authorizationHeader(),
      readJson: json, responseError: requestError,
    });
  }

  async prepareNativeSourceStart(program: BroadcastProgramRef, packagerId: string, requestedRenditions: number,
    allowHardwareAcceleration: boolean, trigger: unknown, signal: AbortSignal, audioOutput?: NativeSourceAudioOutput, videoOutput?: NativeSourceVideoOutput,
  ): Promise<Readonly<{ program: BroadcastProgramRef; assignment: PreparedNativePackagerStart }>> {
    signal.throwIfAborted();
    const { requestNativeSourceStart } = await import("./native-source-program-http");
    const response = await requestNativeSourceStart(program, packagerId, requestedRenditions, allowHardwareAcceleration,
      trigger, signal, audioOutput, { fingerprint: () => this.device.fingerprint(), authorizationHeader: () => this.auth.authorizationHeader() }, videoOutput);
    if (!response.ok) throw requestError(response, "native_source_program_start_failed");
    const prepared = await this.acceptNativeAssignment(response, program, packagerId, signal, undefined, 16384, "trusted-sframe-v1");
    return Object.freeze({ program: prepared.program, assignment: this.takePreparedNative(prepared.program) });
  }

  async prepareNativeHandoff(
    program: BroadcastProgramRef, snapshot: NativePackagerHandoffControl,
    packagerId: string, requestedRenditions: number, signal: AbortSignal,
  ): Promise<Readonly<{ program: BroadcastProgramRef; ownerSubjectRef: string }>> {
    signal.throwIfAborted();
    const { requestNativeHandoff } = await import("./native-source-handoff-http");
    signal.throwIfAborted();
    const { response, control } = await requestNativeHandoff(program, snapshot, packagerId, requestedRenditions,
      true, "user-action", signal, this.device.fingerprint(), () => this.auth.authorizationHeader());
    if (!response.ok) throw requestError(response, "native_handoff_failed");
    return this.acceptNativeAssignment(response, { ...program, programRevision: control.programRevision }, packagerId,
      signal, control.writer!.fencingRevision);
  }

  async prepareNativeSourceHandoff(program: BroadcastProgramRef, snapshot: NativePackagerHandoffControl,
    packagerId: string, requestedRenditions: number, allowHardwareAcceleration: boolean, trigger: unknown, signal: AbortSignal,
  ): Promise<Readonly<{ program: BroadcastProgramRef; assignment: PreparedNativePackagerStart }>> {
    signal.throwIfAborted();
    const { requestNativeHandoff } = await import("./native-source-handoff-http");
    signal.throwIfAborted();
    const { response, control } = await requestNativeHandoff(program, snapshot, packagerId, requestedRenditions,
      allowHardwareAcceleration, trigger, signal, this.device.fingerprint(), () => this.auth.authorizationHeader());
    if (!response.ok) throw requestError(response, "native_handoff_failed");
    const prepared = await this.acceptNativeAssignment(response, { ...program, programRevision: control.programRevision }, packagerId,
      signal, control.writer!.fencingRevision, 16384, "trusted-sframe-v1");
    return Object.freeze({ program: prepared.program, assignment: this.takePreparedNative(prepared.program) });
  }

  private async acceptNativeAssignment(
    response: Response, program: BroadcastProgramRef, packagerId: string, signal: AbortSignal, previousFence?: number, maximumBytes?: number,
    expectedInputMode?: "trusted-sframe-v1",
  ): Promise<Readonly<{ program: BroadcastProgramRef; ownerSubjectRef: string }>> {
    const value = await json(response, "invalid_native_packager_assignment_response", maximumBytes);
    signal.throwIfAborted();
    const { parseNativeAssignmentResponse } = await import("./native-assignment-response");
    signal.throwIfAborted();
    const prepared = parseNativeAssignmentResponse(value, program, packagerId, previousFence, expectedInputMode, programRef);
    this.preparedNative.set(prepared.program.programId, prepared.assignment);
    return Object.freeze({ program: prepared.program, ownerSubjectRef: prepared.ownerSubjectRef });
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
    signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    signal.throwIfAborted();
    const response = await fetch(
      `/api/native-packagers/${encodeURIComponent(assignment.packagerId)}/assignments/${encodeURIComponent(assignment.assignmentId)}`,
      { method: "DELETE", headers: this.auth.authorizationHeader(), credentials: "same-origin", redirect: "error", signal },
    );
    if (!response.ok) throw requestError(response, "native_packager_assignment_stop_failed");
    await json(response, "invalid_native_packager_assignment_stop_response", 16384);
    const deadline = Date.now() + NATIVE_STOP_CONFIRMATION_MS;
    do {
      signal.throwIfAborted();
      const inventoryResponse = await fetch("/api/native-packagers", {
        headers: this.auth.authorizationHeader(),
        credentials: "same-origin",
        redirect: "error",
        signal,
      });
      if (!inventoryResponse.ok) {
        throw requestError(inventoryResponse, "native_packager_assignment_confirmation_failed");
      }
      const inventory = await json(inventoryResponse, "invalid_native_packager_assignment_confirmation", 262144);
      if (!Array.isArray(inventory["assignments"])) {
        throw new BroadcastBrowserPortError("invalid_native_packager_assignment_confirmation");
      }
      const current = inventory["assignments"].find((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
        const item = candidate as Record<string, unknown>;
        return item["assignmentId"] === assignment.assignmentId
          && item["packagerId"] === assignment.packagerId;
      }) as Record<string, unknown> | undefined;
      if (!current || TERMINAL_ASSIGNMENT_STATES.has(String(current["state"]))) return;
      if (!new Set(["preparing", "ready", "starting", "running", "degraded", "draining"]).has(String(current["state"]))) {
        throw new BroadcastBrowserPortError("invalid_native_packager_assignment_confirmation");
      }
      await wait(100, signal);
    } while (Date.now() < deadline);
    throw new BroadcastBrowserPortError("native_packager_assignment_stop_confirmation_timeout");
  }

  /** After program revocation, also fence a prepare whose HTTP response was lost. */
  async confirmNativeProgramStopped(programId: string, signal: AbortSignal): Promise<void> {
    if (!PROGRAM.test(programId)) throw new BroadcastBrowserPortError("invalid_broadcast_program");
    signal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const deadline = Date.now() + NATIVE_STOP_CONFIRMATION_MS;
    do {
      signal.throwIfAborted();
      const response = await fetch("/api/native-packagers", { headers: this.auth.authorizationHeader(),
        credentials: "same-origin", redirect: "error", signal });
      if (!response.ok) throw requestError(response, "native_packager_assignment_confirmation_failed");
      const inventory = await json(response, "invalid_native_packager_assignment_confirmation", 262144);
      if (!Array.isArray(inventory["assignments"]) || inventory["assignments"].length > 1024) {
        throw new BroadcastBrowserPortError("invalid_native_packager_assignment_confirmation");
      }
      let active = false;
      for (const value of inventory["assignments"]) {
        if (!value || typeof value !== "object" || Array.isArray(value) || !PROGRAM.test(value.programId)
          || !["preparing", "ready", "starting", "running", "degraded", "draining", "stopped", "failed"].includes(value.state)) {
          throw new BroadcastBrowserPortError("invalid_native_packager_assignment_confirmation");
        }
        if (value.programId === programId && !TERMINAL_ASSIGNMENT_STATES.has(value.state)) active = true;
      }
      if (!active) return;
      await wait(100, signal);
    } while (Date.now() < deadline);
    throw new BroadcastBrowserPortError("native_packager_assignment_stop_confirmation_timeout");
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
    signal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
    signal.throwIfAborted();
    if (!PROGRAM.test(programId)) throw new BroadcastBrowserPortError("invalid_broadcast_program");
    const response = await fetch(`/api/broadcasts/${encodeURIComponent(programId)}`, {
      method: "DELETE",
      headers: this.auth.authorizationHeader(),
      credentials: "same-origin",
      redirect: "error",
      signal,
    });
    if (!response.ok) throw requestError(response, "broadcast_program_stop_failed");
    const value = await json(response, "invalid_broadcast_stop_response", 16384);
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
