import { Injectable, signal } from "@angular/core";
import { OidcAuthService } from "../auth/oidc-auth.service";
import { DeviceIdentityService } from "../identity/device-identity.service";
import { BroadcastBrowserPortError } from "./broadcast-ports";

export interface NativeStandbyControl {
  readonly controlVersion: 1;
  readonly programId: string;
  readonly programRevision: number;
  readonly programEpoch: number;
  readonly standbyRevision: number;
  readonly standbyPackagerIds: readonly string[];
}
const PACKAGER = /^pkr_[A-Za-z0-9_-]{16,64}$/;
const fields = new Set(["controlVersion", "programId", "programRevision", "programEpoch", "standbyRevision", "standbyPackagerIds"]);
const fail = (code: string): never => { throw new BroadcastBrowserPortError(code); };

export function parseNativeStandbyControl(value: unknown, programId: string, epoch: number): NativeStandbyControl {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_native_standby_control");
  const item = value as Record<string, unknown>;
  const ids = item["standbyPackagerIds"];
  if (Object.keys(item).length !== fields.size || Object.keys(item).some(key => !fields.has(key))
    || item["controlVersion"] !== 1 || item["programId"] !== programId || item["programEpoch"] !== epoch
    || !/^prg_[A-Za-z0-9_-]{16,64}$/.test(programId) || !Number.isSafeInteger(epoch) || epoch < 1
    || !Number.isSafeInteger(item["programRevision"]) || Number(item["programRevision"]) < 1
    || !Number.isSafeInteger(item["standbyRevision"]) || Number(item["standbyRevision"]) < 0
    || !Array.isArray(ids) || ids.length > 2 || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== "string" || !PACKAGER.test(id))) return fail("invalid_native_standby_control");
  return Object.freeze({ controlVersion: 1, programId, programEpoch: epoch,
    programRevision: Number(item["programRevision"]), standbyRevision: Number(item["standbyRevision"]),
    standbyPackagerIds: Object.freeze([...ids]) });
}

// Component-scoped metadata port. It has no capture, media or assignment dependency.
@Injectable()
export class NativePackagerStandbyService {
  readonly control = signal<NativeStandbyControl | null>(null);
  readonly selected = signal<readonly string[]>([]);
  readonly busy = signal(false);
  readonly error = signal("");
  private scope: Readonly<{ programId: string; epoch: number }> | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly auth: OidcAuthService, private readonly device: DeviceIdentityService) {}

  setScope(programId: string, epoch: number): void {
    if (this.scope?.programId === programId && this.scope.epoch === epoch) return;
    this.reset();
    if (/^prg_[A-Za-z0-9_-]{16,64}$/.test(programId) && Number.isSafeInteger(epoch) && epoch > 0) {
      this.scope = Object.freeze({ programId, epoch });
    }
  }

  reset(): void {
    this.controller?.abort(); this.controller = null; this.scope = null;
    this.control.set(null); this.selected.set([]); this.busy.set(false); this.error.set("");
  }

  select(packagerId: string, enabled: boolean): void {
    if (this.busy() || !this.control() || !PACKAGER.test(packagerId)) return;
    const next = this.selected().filter(id => id !== packagerId);
    if (enabled) next.push(packagerId);
    if (next.length <= 2) this.selected.set(Object.freeze(next));
  }

  async load(trigger: unknown): Promise<void> { await this.request(false, 1, trigger); }
  async save(requestedRenditions: number, trigger: unknown): Promise<void> {
    await this.request(true, requestedRenditions, trigger);
  }

  private async request(write: boolean, requestedRenditions: number, trigger: unknown): Promise<void> {
    if (trigger !== "user-action") return fail("explicit_native_standby_action_required");
    const scope = this.scope, previous = this.control(), selected = [...this.selected()];
    const fingerprint = this.device.fingerprint();
    if (this.busy() || !scope || !fingerprint || (write && (!previous
      || !Number.isSafeInteger(requestedRenditions) || requestedRenditions < 1 || requestedRenditions > 3))) {
      return fail("invalid_native_standby_selection");
    }
    const headers = this.auth.authorizationHeader();
    if (!headers["Authorization"]) return fail("native_standby_authentication_required");
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    this.busy.set(true); this.error.set("");
    try {
      const response = await fetch(`/api/broadcasts/${scope.programId}/${write ? "native-standbys" : "native-standby-control"}`, {
        method: write ? "PUT" : "POST", headers: { ...headers, "content-type": "application/json" },
        credentials: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal,
        body: JSON.stringify({ requestVersion: 1, deviceFingerprint: fingerprint, ...(write && previous ? {
          trigger: "user-action", expectedProgramRevision: previous.programRevision, expectedProgramEpoch: scope.epoch,
          expectedStandbyRevision: previous.standbyRevision, standbyPackagerIds: selected,
          requestedRenditions, allowHardwareAcceleration: true,
        } : {}) }),
      });
      if (!response.ok) fail(response.status === 409 ? "stale_native_standby_selection" : "native_standby_request_failed");
      const result = parseNativeStandbyControl(await response.json(), scope.programId, scope.epoch);
      controller.signal.throwIfAborted();
      if (this.scope !== scope || this.controller !== controller) return;
      if (this.device.fingerprint() !== fingerprint
        || JSON.stringify(this.auth.authorizationHeader()) !== JSON.stringify(headers)) fail("stale_native_standby_selection");
      if (write && (result.standbyRevision !== previous!.standbyRevision + 1
        || result.programRevision !== previous!.programRevision
        || JSON.stringify(result.standbyPackagerIds) !== JSON.stringify(selected))) fail("invalid_native_standby_control");
      this.control.set(result); this.selected.set(result.standbyPackagerIds);
    } catch (error) {
      if (this.controller === controller) {
        this.control.set(null); this.selected.set([]);
        this.error.set(error instanceof BroadcastBrowserPortError ? error.message : "native_standby_request_failed");
      }
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) { this.controller = null; this.busy.set(false); }
    }
  }
}
