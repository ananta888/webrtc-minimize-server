import { Injectable, signal } from "@angular/core";

import { OidcAuthService } from "../auth/oidc-auth.service";

export type NativePackagerPlatform = "linux" | "macos" | "windows";

export interface NativePackagerTarget {
  readonly id: string;
  readonly platform: NativePackagerPlatform;
  readonly label: string;
}

export interface OwnedNativePackager {
  readonly id: string;
  readonly label: string;
  readonly platform: NativePackagerPlatform;
  readonly keyFingerprint: string;
  readonly createdAt: number;
  readonly lastAuthenticatedAt: number;
  readonly revokedAt: number;
  readonly online: boolean;
  readonly consentedRoomIds: readonly string[];
  readonly capability: Readonly<{ ffmpegVersion: string; health: string; maximumRenditions: number }> | null;
  readonly heartbeat: Readonly<{ state: string; observedAt: number }> | null;
}

export interface PendingNativePackagerInstallation {
  readonly packagerId: string;
  readonly filename: string;
  readonly target: string;
  readonly expiresAt: number;
}

const PACKAGER_ID = /^pkr_[A-Za-z0-9_-]{16,64}$/;
const TARGET_ID = /^(?:linux|macos|windows)-(?:amd64|arm64)$/;
const ROOM_ID = /^[A-Za-z0-9_-]{4,64}$/;

function parsePackager(value: unknown): OwnedNativePackager {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("native_packager_list_invalid");
  const item = value as Partial<OwnedNativePackager>;
  if (!PACKAGER_ID.test(item.id || "") || typeof item.label !== "string" || item.label.length < 1 || item.label.length > 48
    || !new Set(["linux", "macos", "windows"]).has(String(item.platform))
    || !/^[A-Za-z0-9_-]{43}$/.test(item.keyFingerprint || "")
    || !Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(item.lastAuthenticatedAt)
    || !Number.isSafeInteger(item.revokedAt) || typeof item.online !== "boolean"
    || !Array.isArray(item.consentedRoomIds) || item.consentedRoomIds.length > 20
    || item.consentedRoomIds.some((roomId) => !ROOM_ID.test(roomId))) throw new Error("native_packager_list_invalid");
  return Object.freeze(item as OwnedNativePackager);
}

@Injectable({ providedIn: "root" })
export class NativePackagerOnboardingService {
  readonly packagers = signal<readonly OwnedNativePackager[]>([]);
  readonly pending = signal<PendingNativePackagerInstallation | null>(null);
  readonly busy = signal(false);
  readonly error = signal("");

  constructor(private readonly auth: OidcAuthService) {}

  clear(): void { this.packagers.set([]); this.pending.set(null); this.error.set(""); }

  suggestedTarget(targets: readonly NativePackagerTarget[]): string {
    const platform = String(navigator.platform || "").toLowerCase();
    const userAgent = String(navigator.userAgent || "").toLowerCase();
    const target = platform.includes("win") ? "windows-amd64"
      : platform.includes("mac") ? (userAgent.includes("arm64") ? "macos-arm64" : "macos-amd64")
        : userAgent.includes("aarch64") || userAgent.includes("arm64") ? "linux-arm64" : "linux-amd64";
    return targets.some(({ id }) => id === target) ? target : targets[0]?.id || "";
  }

  async load(): Promise<void> {
    this.busy.set(true); this.error.set("");
    try {
      const response = await fetch("/api/native-packagers", { headers: this.auth.authorizationHeader() });
      const body = await response.json() as { packagers?: unknown[]; error?: string };
      if (!response.ok || !Array.isArray(body.packagers)) throw new Error(body.error || "native_packager_list_failed");
      this.packagers.set(body.packagers.map(parsePackager));
    } catch (error) {
      this.packagers.set([]); this.error.set(error instanceof Error ? error.message : "native_packager_list_failed");
    } finally { this.busy.set(false); }
  }

  async downloadInstaller(target: string, label: string): Promise<void> {
    if (!TARGET_ID.test(target)) throw new Error("native_packager_target_invalid");
    this.busy.set(true); this.error.set("");
    try {
      const response = await fetch("/api/native-packagers/enrollments", {
        method: "POST",
        headers: { "content-type": "application/json", ...this.auth.authorizationHeader() },
        body: JSON.stringify({ target, label }),
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(body["error"] || "native_packager_installer_failed"));
      const packagerId = String(body["packagerId"] || "");
      const filename = String(body["filename"] || "");
      const installer = String(body["installer"] || "");
      const expiresAt = Number(body["expiresAt"]);
      if (!PACKAGER_ID.test(packagerId) || body["target"] !== target
        || !/^ananta-native-packager-[a-z0-9-]+\.(?:sh|ps1)$/.test(filename)
        || installer.length < 100 || installer.length > 128 * 1024
        || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error("native_packager_installer_invalid");
      const url = URL.createObjectURL(new Blob([installer], { type: "text/plain;charset=utf-8" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.hidden = true; document.body.append(anchor);
      try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); }
      this.pending.set(Object.freeze({ packagerId, filename, target, expiresAt }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "native_packager_installer_failed"; this.error.set(message); throw error;
    } finally { this.busy.set(false); }
  }

  async setRoomConsent(packagerId: string, roomId: string, enabled: boolean): Promise<void> {
    if (!PACKAGER_ID.test(packagerId) || !ROOM_ID.test(roomId)) throw new Error("native_packager_room_consent_invalid");
    this.busy.set(true); this.error.set("");
    try {
      const response = await fetch(`/api/native-packagers/${encodeURIComponent(packagerId)}/room-consents/${encodeURIComponent(roomId)}`, {
        method: "PUT", headers: { "content-type": "application/json", ...this.auth.authorizationHeader() }, body: JSON.stringify({ enabled }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "native_packager_room_consent_failed");
      await this.load();
    } catch (error) {
      const message = error instanceof Error ? error.message : "native_packager_room_consent_failed"; this.error.set(message); throw error;
    } finally { this.busy.set(false); }
  }

  async revoke(packagerId: string): Promise<void> {
    if (!PACKAGER_ID.test(packagerId)) throw new Error("native_packager_not_found");
    this.busy.set(true); this.error.set("");
    try {
      const response = await fetch(`/api/native-packagers/${encodeURIComponent(packagerId)}`, { method: "DELETE", headers: this.auth.authorizationHeader() });
      const body = await response.json() as { error?: string }; if (!response.ok) throw new Error(body.error || "native_packager_revoke_failed"); await this.load();
    } catch (error) {
      const message = error instanceof Error ? error.message : "native_packager_revoke_failed"; this.error.set(message); throw error;
    } finally { this.busy.set(false); }
  }
}
