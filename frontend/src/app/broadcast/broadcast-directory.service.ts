import { Injectable, signal } from "@angular/core";

import { OidcAuthService } from "../auth/oidc-auth.service";
import {
  BroadcastGrantProofContext,
  DeviceIdentityService,
} from "../identity/device-identity.service";

export type BroadcastDirectoryAvailability = "live" | "degraded" | "ended" | "offline";
export type BroadcastDirectoryVisibility = "private" | "unlisted" | "public";
export type BroadcastLatencyMode = "ll-hls" | "standard-hls" | "moq-experimental";

export interface BroadcastDirectoryEntry {
  readonly directoryVersion: 1;
  readonly programId: string;
  readonly title: string;
  readonly ownerLabel: string | null;
  readonly ownerVisibility: "shown" | "hidden";
  readonly visibility: BroadcastDirectoryVisibility;
  readonly availability: BroadcastDirectoryAvailability;
  readonly viewerCount: number;
  readonly latencyMode: BroadcastLatencyMode;
  readonly captions: boolean;
  readonly programEpoch: number;
  readonly policyRevision: number;
  readonly playback: "public" | "grant-required";
}

export interface BroadcastPlaybackBootstrap {
  readonly bootstrapVersion: 1;
  readonly program: BroadcastDirectoryEntry;
  readonly resourceRef: string;
  readonly playbackGrant: string;
  readonly expiresAt: number;
}

type DirectoryLifecycle = "idle" | "loading" | "ready" | "failed";
const PROGRAM = /^prg_[A-Za-z0-9_-]{16,64}$/;
const RESOURCE = /^res_[A-Za-z0-9_-]{16,64}$/;
const CHALLENGE = /^bpc_[A-Za-z0-9_-]{24,64}$/;
const FIELDS = new Set([
  "directoryVersion", "programId", "title", "ownerLabel", "ownerVisibility", "visibility",
  "availability", "viewerCount", "latencyMode", "captions", "programEpoch", "policyRevision", "playback",
]);

export function parseBroadcastDirectoryEntry(value: unknown): BroadcastDirectoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_broadcast_directory_response");
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).length !== FIELDS.size || Object.keys(entry).some((field) => !FIELDS.has(field))
    || entry["directoryVersion"] !== 1 || !PROGRAM.test(String(entry["programId"] || ""))
    || typeof entry["title"] !== "string" || entry["title"].length < 1 || entry["title"].length > 80
    || !new Set(["shown", "hidden"]).has(String(entry["ownerVisibility"]))
    || (entry["ownerVisibility"] === "shown"
      ? typeof entry["ownerLabel"] !== "string" || entry["ownerLabel"].length < 1 || entry["ownerLabel"].length > 80
      : entry["ownerLabel"] !== null)
    || !new Set(["private", "unlisted", "public"]).has(String(entry["visibility"]))
    || !new Set(["live", "degraded", "ended", "offline"]).has(String(entry["availability"]))
    || !Number.isSafeInteger(entry["viewerCount"]) || Number(entry["viewerCount"]) < 0
    || Number(entry["viewerCount"]) > 1_000_000
    || !new Set(["ll-hls", "standard-hls", "moq-experimental"]).has(String(entry["latencyMode"]))
    || typeof entry["captions"] !== "boolean"
    || !Number.isSafeInteger(entry["programEpoch"]) || Number(entry["programEpoch"]) < 1
    || !Number.isSafeInteger(entry["policyRevision"]) || Number(entry["policyRevision"]) < 1
    || !new Set(["public", "grant-required"]).has(String(entry["playback"]))) {
    throw new Error("invalid_broadcast_directory_response");
  }
  return Object.freeze({ ...entry }) as unknown as BroadcastDirectoryEntry;
}

function parseList(value: unknown, visibility?: "public"): readonly BroadcastDirectoryEntry[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("invalid_broadcast_directory_response");
  const entries = value.map(parseBroadcastDirectoryEntry);
  if (new Set(entries.map(({ programId }) => programId)).size !== entries.length
    || (visibility && entries.some((entry) => entry.visibility !== visibility
      || !new Set(["live", "degraded"]).has(entry.availability)))) {
    throw new Error("invalid_broadcast_directory_response");
  }
  return Object.freeze(entries);
}

async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new Error("invalid_broadcast_directory_response"); }
}

@Injectable({ providedIn: "root" })
export class BroadcastDirectoryService {
  readonly lifecycle = signal<DirectoryLifecycle>("idle");
  readonly publicPrograms = signal<readonly BroadcastDirectoryEntry[]>([]);
  readonly privatePrograms = signal<readonly BroadcastDirectoryEntry[]>([]);
  readonly ownPrograms = signal<readonly BroadcastDirectoryEntry[]>([]);
  readonly endedPrograms = signal<readonly BroadcastDirectoryEntry[]>([]);
  readonly errorCode = signal("");
  private controller: AbortController | null = null;

  constructor(
    private readonly auth: OidcAuthService,
    private readonly device: DeviceIdentityService,
  ) {}

  async load(authenticated: boolean): Promise<void> {
    this.controller?.abort(new DOMException("refresh", "AbortError"));
    const controller = new AbortController();
    this.controller = controller;
    this.lifecycle.set("loading");
    this.errorCode.set("");
    try {
      const requests = [fetch("/api/broadcasts/public", {
        cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal,
      })];
      if (authenticated) requests.push(fetch("/api/broadcasts/mine", {
        headers: this.auth.authorizationHeader(),
        cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal,
      }));
      const responses = await Promise.all(requests);
      if (!responses[0].ok) throw new Error("broadcast_directory_unavailable");
      const publicBody = await responseJson(responses[0]) as Record<string, unknown>;
      if (!publicBody || typeof publicBody !== "object" || Array.isArray(publicBody)
        || Object.keys(publicBody).length !== 1 || !Object.hasOwn(publicBody, "programs")) {
        throw new Error("invalid_broadcast_directory_response");
      }
      const publicPrograms = parseList(publicBody["programs"], "public");
      let authorized: readonly BroadcastDirectoryEntry[] = [];
      let owned: readonly BroadcastDirectoryEntry[] = [];
      if (authenticated) {
        if (!responses[1].ok) throw new Error(responses[1].status === 401
          ? "broadcast_directory_sign_in_required" : "broadcast_directory_unavailable");
        const ownBody = await responseJson(responses[1]) as Record<string, unknown>;
        if (!ownBody || typeof ownBody !== "object" || Array.isArray(ownBody)
          || Object.keys(ownBody).length !== 2 || !Object.hasOwn(ownBody, "authorized")
          || !Object.hasOwn(ownBody, "owned")) throw new Error("invalid_broadcast_directory_response");
        authorized = parseList(ownBody["authorized"]);
        owned = parseList(ownBody["owned"]);
      }
      const ended = [...authorized, ...owned].filter(({ availability }) => (
        availability === "ended" || availability === "offline"
      ));
      this.publicPrograms.set(publicPrograms);
      this.privatePrograms.set(Object.freeze(authorized.filter(({ availability }) => (
        availability === "live" || availability === "degraded"
      ))));
      this.ownPrograms.set(Object.freeze(owned.filter(({ availability }) => (
        availability === "live" || availability === "degraded"
      ))));
      this.endedPrograms.set(Object.freeze(ended));
      this.lifecycle.set("ready");
    } catch (error) {
      if (controller.signal.aborted) return;
      this.lifecycle.set("failed");
      this.errorCode.set(error instanceof Error ? error.message : "broadcast_directory_unavailable");
      throw error;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  async authorize(programId: string, signal: AbortSignal): Promise<BroadcastPlaybackBootstrap> {
    if (!PROGRAM.test(programId)) throw new Error("broadcast_not_available");
    const challengeResponse = await fetch(
      `/api/broadcasts/${encodeURIComponent(programId)}/playback-challenges`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.auth.authorizationHeader() },
        credentials: "same-origin",
        redirect: "error",
        signal,
        body: JSON.stringify({ requestVersion: 1 }),
      },
    );
    if (challengeResponse.status === 401) throw new Error("broadcast_directory_sign_in_required");
    if (challengeResponse.status === 404 || challengeResponse.status === 403) {
      throw new Error("broadcast_not_available");
    }
    if (!challengeResponse.ok) throw new Error("broadcast_playback_authorization_failed");
    const challenge = await responseJson(challengeResponse) as Record<string, unknown>;
    if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)
      || Object.keys(challenge).length !== 4
      || challenge["challengeVersion"] !== 1
      || !CHALLENGE.test(String(challenge["challengeId"] || ""))
      || !Number.isSafeInteger(challenge["expiresAt"]) || Number(challenge["expiresAt"]) <= Date.now()
      || !challenge["proofContext"] || typeof challenge["proofContext"] !== "object"
      || Array.isArray(challenge["proofContext"])) {
      throw new Error("invalid_broadcast_playback_challenge");
    }
    const deviceProof = await this.device.createBroadcastGrantProof(
      challenge["proofContext"] as BroadcastGrantProofContext,
    );
    signal.throwIfAborted();
    const response = await fetch(`/api/broadcasts/${encodeURIComponent(programId)}/playback`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.auth.authorizationHeader() },
      credentials: "same-origin",
      redirect: "error",
      signal,
      body: JSON.stringify({
        requestVersion: 1,
        challengeId: challenge["challengeId"],
        deviceProof,
      }),
    });
    if (response.status === 401) throw new Error("broadcast_directory_sign_in_required");
    if (response.status === 404 || response.status === 403) throw new Error("broadcast_not_available");
    if (response.status === 410) throw new Error("broadcast_ended");
    if (response.status === 503) throw new Error("broadcast_offline");
    if (!response.ok) throw new Error("broadcast_playback_authorization_failed");
    const value = await responseJson(response) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 5
      || !Object.hasOwn(value, "bootstrapVersion") || !Object.hasOwn(value, "program")
      || !Object.hasOwn(value, "resourceRef") || !Object.hasOwn(value, "playbackGrant")
      || !Object.hasOwn(value, "expiresAt") || value["bootstrapVersion"] !== 1
      || !RESOURCE.test(String(value["resourceRef"] || ""))
      || typeof value["playbackGrant"] !== "string" || value["playbackGrant"].length < 16
      || value["playbackGrant"].length > 8 * 1024 || /[\u0000-\u001f\u007f]/.test(value["playbackGrant"])
      || !Number.isSafeInteger(value["expiresAt"]) || Number(value["expiresAt"]) <= Date.now()) {
      throw new Error("invalid_broadcast_playback_bootstrap");
    }
    const program = parseBroadcastDirectoryEntry(value["program"]);
    if (program.programId !== programId || !new Set(["live", "degraded"]).has(program.availability)) {
      throw new Error("invalid_broadcast_playback_bootstrap");
    }
    return Object.freeze({
      bootstrapVersion: 1,
      program,
      resourceRef: String(value["resourceRef"]),
      playbackGrant: String(value["playbackGrant"]),
      expiresAt: Number(value["expiresAt"]),
    });
  }

  deepLink(programId: string): string {
    if (!PROGRAM.test(programId)) throw new Error("invalid_broadcast_program_id");
    return `/?section=broadcast&program=${encodeURIComponent(programId)}`;
  }

  programFromUrl(url: string): string | null {
    let parsed: URL;
    try { parsed = new URL(url, location.origin); } catch { return null; }
    if (parsed.origin !== location.origin || parsed.pathname !== "/") return null;
    const keys: string[] = [];
    parsed.searchParams.forEach((_value, key) => keys.push(key));
    if (keys.some((key) => !new Set(["section", "program"]).has(key))
      || parsed.searchParams.get("section") !== "broadcast") return null;
    const programId = parsed.searchParams.get("program");
    return programId && PROGRAM.test(programId) ? programId : null;
  }

  destroy(): void {
    this.controller?.abort(new DOMException("destroy", "AbortError"));
    this.controller = null;
  }
}
