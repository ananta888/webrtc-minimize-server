import { Injectable, signal } from "@angular/core";
import { OidcAuthService } from "../auth/oidc-auth.service";
import { DeviceIdentityService } from "../identity/device-identity.service";
import { BroadcastSourceKind } from "./broadcast-ports";
import { parseNativeHandoffControl } from "./native-packager-handoff-control";

export interface SourceInvitation {
  readonly requestId: string; readonly roomId: string; readonly programId: string;
  readonly programRevision: number; readonly programEpoch: number;
  readonly ownerPeerId: string; readonly targetPeerId: string; readonly packagerRef: string;
  readonly sourceKind: BroadcastSourceKind; readonly state: "pending" | "declined" | "cancelled" | "invalidated";
  readonly createdAt: number; readonly expiresAt: number; readonly authority: "none";
}
export interface SourceRequestProgram { readonly programId: string; readonly programRevision: number; readonly programEpoch: number }
export const SOURCE_REQUEST_KINDS = Object.freeze(["microphone", "camera", "screen", "screen-audio"] as const);
const fields = ["requestId", "roomId", "programId", "programRevision", "programEpoch", "ownerPeerId", "targetPeerId",
  "packagerRef", "sourceKind", "state", "createdAt", "expiresAt", "authority"];
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
    if (!value || typeof value !== "object" || Object.keys(value).length !== fields.length
      || Object.keys(value).some(key => !fields.includes(key)) || value.roomId !== roomId
      || typeof value.requestId !== "string" || !/^bsr_[A-Za-z0-9_-]{24}$/.test(value.requestId) || ids.has(value.requestId)
      || typeof value.programId !== "string" || !/^prg_[A-Za-z0-9_-]{16,64}$/.test(value.programId)
      || !positive(value.programRevision) || !positive(value.programEpoch)
      || typeof value.packagerRef !== "string" || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(value.packagerRef)
      || typeof value.ownerPeerId !== "string" || typeof value.targetPeerId !== "string"
      || !peer.test(value.ownerPeerId) || !peer.test(value.targetPeerId) || value.ownerPeerId === value.targetPeerId
      || (value.ownerPeerId !== peerId && value.targetPeerId !== peerId)
      || !SOURCE_REQUEST_KINDS.includes(value.sourceKind)
      || !["pending", "declined", "cancelled", "invalidated"].includes(value.state) || value.authority !== "none"
      || !positive(value.createdAt) || !positive(value.expiresAt) || value.expiresAt <= value.createdAt
      || value.expiresAt - value.createdAt > 120_000 || value.createdAt > now + 5000) return fail();
    ids.add(value.requestId); return Object.freeze({ ...value });
  }));
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json" || !response.body) return fail();
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) { cancel(); return fail(); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    signal.throwIfAborted(); return JSON.parse(text + decoder.decode());
  } catch (error) { cancel(); throw error; }
  finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

@Injectable()
export class BroadcastSourceRequestsService {
  readonly items = signal<readonly SourceInvitation[]>([]);
  readonly busy = signal(false);
  readonly error = signal("");
  readonly loaded = signal(false);
  private scope: Readonly<{ roomId: string; peerId: string }> | null = null;
  private controller: AbortController | null = null;
  constructor(private readonly auth: OidcAuthService, private readonly device: DeviceIdentityService) {}
  setScope(roomId: string, peerId: string): void {
    if (this.scope?.roomId === roomId && this.scope.peerId === peerId) return;
    this.reset();
    if (/^[a-z0-9][a-z0-9-]{5,47}$/.test(roomId) && peer.test(peerId)) this.scope = Object.freeze({ roomId, peerId });
  }
  reset(): void {
    this.controller?.abort(); this.controller = null; this.scope = null;
    this.items.set([]); this.loaded.set(false); this.busy.set(false); this.error.set("");
  }
  async load(): Promise<void> { await this.request("list", {}); }
  async create(program: SourceRequestProgram, targetPeerId: string, sourceKind: BroadcastSourceKind): Promise<void> {
    if (!/^prg_[A-Za-z0-9_-]{16,64}$/.test(program.programId) || !positive(program.programRevision)
      || !positive(program.programEpoch) || !peer.test(targetPeerId) || targetPeerId === this.scope?.peerId
      || !SOURCE_REQUEST_KINDS.includes(sourceKind)) return;
    await this.request("create", { programId: program.programId, expectedProgramRevision: program.programRevision,
      expectedProgramEpoch: program.programEpoch, targetPeerId, sourceKind });
  }
  async finish(item: SourceInvitation): Promise<void> {
    if (!this.items().includes(item) || item.state !== "pending" || item.expiresAt <= Date.now()) return;
    await this.request(item.ownerPeerId === this.scope?.peerId ? "cancel" : "decline", { requestId: item.requestId });
  }
  private async request(action: "list" | "create" | "cancel" | "decline", extra: Record<string, unknown>): Promise<void> {
    const scope = this.scope, fingerprint = this.device.fingerprint(), headers = this.auth.authorizationHeader();
    const previous = this.items().find(item => item.requestId === extra["requestId"]);
    if (!scope || this.busy()) return;
    if (!fingerprint || !headers["Authorization"]) { this.items.set([]); this.loaded.set(false); this.error.set("Anmeldung oder Gerätebindung fehlt."); return; }
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), 15000); this.busy.set(true); this.error.set("");
    try {
      const current = () => {
        controller.signal.throwIfAborted();
        if (this.scope !== scope || this.controller !== controller || this.device.fingerprint() !== fingerprint
          || JSON.stringify(this.auth.authorizationHeader()) !== JSON.stringify(headers)) throw new Error("identity");
      };
      if (action === "create") {
        const snapshot = await fetch(`/api/broadcasts/${extra["programId"]}/native-handoff-control`, {
          method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal,
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ requestVersion: 1, deviceFingerprint: fingerprint }),
        });
        if (!snapshot.ok) throw new Error("request");
        const control = parseNativeHandoffControl(await readResponse(snapshot, controller.signal), String(extra["programId"]));
        current();
        if (control.programEpoch !== extra["expectedProgramEpoch"] || control.handoffPending || !control.writer
          || !["live", "degraded"].includes(control.state)) throw new Error("conflict");
        extra = { ...extra, expectedProgramRevision: control.programRevision };
      }
      const response = await fetch("/api/broadcast-source-requests", { method: "POST", credentials: "same-origin",
        redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ requestVersion: 1,
          action, roomId: scope.roomId, deviceFingerprint: fingerprint, ...extra,
          ...(action === "list" ? {} : { trigger: "user-action" }) }) });
      if (!response.ok) throw new Error(response.status === 409 ? "conflict" : response.status === 429 ? "quota" : "request");
      const items = parseSourceInvitations(await readResponse(response, controller.signal), scope.roomId, scope.peerId);
      controller.signal.throwIfAborted();
      if (this.scope !== scope || this.controller !== controller) return;
      if (this.device.fingerprint() !== fingerprint || JSON.stringify(this.auth.authorizationHeader()) !== JSON.stringify(headers)) throw new Error("identity");
      if (action !== "list" && (items.length !== 1 || (action === "create"
        ? items[0].programId !== extra["programId"] || items[0].programRevision !== extra["expectedProgramRevision"]
          || items[0].programEpoch !== extra["expectedProgramEpoch"] || items[0].targetPeerId !== extra["targetPeerId"]
          || items[0].sourceKind !== extra["sourceKind"] || items[0].ownerPeerId !== scope.peerId || items[0].state !== "pending"
        : items[0].requestId !== extra["requestId"] || items[0].state !== (action === "cancel" ? "cancelled" : "declined")))) fail();
      if (["cancel", "decline"].includes(action) && (!previous
        || fields.filter(key => key !== "state").some(key => items[0][key as keyof SourceInvitation] !== previous[key as keyof SourceInvitation]))) fail();
      if (action === "create" && this.items().some(item => item.requestId === items[0].requestId)) fail();
      this.items.set(action === "list" ? items : Object.freeze([...this.items().filter(item => item.requestId !== items[0].requestId), ...items].slice(-40)));
      this.loaded.set(true);
    } catch (error) {
      controller.abort();
      if (this.controller === controller) {
        this.items.set([]); this.loaded.set(false);
        this.error.set(error instanceof Error && error.message === "conflict" ? "Serverstand geändert. Bitte erneut laden."
          : error instanceof Error && error.message === "quota" ? "Anfragelimit erreicht. Bitte später erneut laden."
          : "Anfrage nicht bestätigt. Bitte Serverstand erneut laden; es erfolgt keine automatische Wiederholung.");
      }
    } finally { clearTimeout(timer); if (this.controller === controller) { this.controller = null; this.busy.set(false); } }
  }
}
