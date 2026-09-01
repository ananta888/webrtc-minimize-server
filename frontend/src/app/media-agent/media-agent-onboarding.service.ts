import { Injectable, signal } from "@angular/core";

import { OidcAuthService } from "../auth/oidc-auth.service";

export type MediaAgentPlatform = "linux" | "macos" | "windows";

export interface MediaAgentTarget {
  readonly id: string;
  readonly platform: MediaAgentPlatform;
  readonly label: string;
}

export interface OwnedMediaAgent {
  readonly id: string;
  readonly label: string;
  readonly platform: MediaAgentPlatform;
  readonly keyFingerprint: string;
  readonly createdAt: number;
  readonly lastAuthenticatedAt: number;
  readonly revokedAt: number;
  readonly online: boolean;
}

export interface PendingMediaAgentInstallation {
  readonly agentId: string;
  readonly filename: string;
  readonly target: string;
  readonly expiresAt: number;
}

interface InstallerResponse extends PendingMediaAgentInstallation {
  readonly artifactSha256: string;
  readonly artifactBytes: number;
  readonly installer: string;
  readonly error?: string;
}

const AGENT_ID_PATTERN = /^edge-[a-f0-9]{16}$/;
const TARGET_ID_PATTERN = /^(?:linux|macos|windows)-(?:amd64|arm64)$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function parseAgent(value: unknown): OwnedMediaAgent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("media_agent_list_invalid");
  const agent = value as Partial<OwnedMediaAgent>;
  if (!AGENT_ID_PATTERN.test(agent.id || "")
    || typeof agent.label !== "string" || agent.label.length < 1 || agent.label.length > 48
    || !new Set(["linux", "macos", "windows"]).has(String(agent.platform))
    || !FINGERPRINT_PATTERN.test(agent.keyFingerprint || "")
    || !Number.isSafeInteger(agent.createdAt) || Number(agent.createdAt) < 1
    || !Number.isSafeInteger(agent.lastAuthenticatedAt) || Number(agent.lastAuthenticatedAt) < 0
    || !Number.isSafeInteger(agent.revokedAt) || Number(agent.revokedAt) < 0
    || typeof agent.online !== "boolean") throw new Error("media_agent_list_invalid");
  return agent as OwnedMediaAgent;
}

function parseInstaller(value: unknown, requestedTarget: string): InstallerResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("media_agent_installer_invalid");
  const installer = value as Partial<InstallerResponse>;
  if (!AGENT_ID_PATTERN.test(installer.agentId || "")
    || installer.target !== requestedTarget || !TARGET_ID_PATTERN.test(installer.target || "")
    || typeof installer.filename !== "string"
    || !/^ananta-media-agent-[a-z0-9-]+\.(?:sh|ps1)$/.test(installer.filename)
    || !Number.isSafeInteger(installer.expiresAt) || Number(installer.expiresAt) <= Date.now()
    || Number(installer.expiresAt) > Date.now() + 31 * 60_000
    || !/^[a-f0-9]{64}$/.test(installer.artifactSha256 || "")
    || !Number.isSafeInteger(installer.artifactBytes) || Number(installer.artifactBytes) < 1
    || Number(installer.artifactBytes) > 128 * 1024 * 1024
    || typeof installer.installer !== "string" || installer.installer.length < 100
    || installer.installer.length > 128 * 1024) throw new Error("media_agent_installer_invalid");
  return installer as InstallerResponse;
}

@Injectable({ providedIn: "root" })
export class MediaAgentOnboardingService {
  readonly agents = signal<readonly OwnedMediaAgent[]>([]);
  readonly pending = signal<PendingMediaAgentInstallation | null>(null);
  readonly busy = signal(false);
  readonly error = signal("");

  constructor(private readonly auth: OidcAuthService) {}

  suggestedTarget(targets: readonly MediaAgentTarget[]): string {
    const platform = String(navigator.platform || "").toLowerCase();
    const userAgent = String(navigator.userAgent || "").toLowerCase();
    const wanted = platform.includes("win") ? "windows-amd64"
      : platform.includes("mac") ? (userAgent.includes("arm64") ? "macos-arm64" : "macos-amd64")
        : userAgent.includes("aarch64") || userAgent.includes("arm64") ? "linux-arm64" : "linux-amd64";
    return targets.some(({ id }) => id === wanted) ? wanted : targets[0]?.id || "";
  }

  clear(): void {
    this.agents.set([]);
    this.pending.set(null);
    this.error.set("");
  }

  async load(): Promise<void> {
    this.busy.set(true);
    this.error.set("");
    try {
      const response = await fetch("/api/media-agents", { headers: this.auth.authorizationHeader() });
      const body = await response.json() as { agents?: unknown[]; error?: string };
      if (!response.ok) throw new Error(body.error || "media_agent_list_failed");
      if (!Array.isArray(body.agents)) throw new Error("media_agent_list_invalid");
      this.agents.set(body.agents.map(parseAgent));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : "media_agent_list_failed");
    } finally {
      this.busy.set(false);
    }
  }

  async downloadInstaller(target: string, label: string): Promise<PendingMediaAgentInstallation> {
    this.busy.set(true);
    this.error.set("");
    try {
      const response = await fetch("/api/media-agents/enrollments", {
        method: "POST",
        headers: { "content-type": "application/json", ...this.auth.authorizationHeader() },
        body: JSON.stringify({ target, label }),
      });
      const body = await response.json() as InstallerResponse;
      if (!response.ok) throw new Error(body.error || "media_agent_installer_failed");
      const installer = parseInstaller(body, target);
      const download = new Blob([installer.installer], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(download);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = installer.filename;
      anchor.hidden = true;
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
        URL.revokeObjectURL(url);
      }
      const pending = Object.freeze({
        agentId: installer.agentId,
        filename: installer.filename,
        target: installer.target,
        expiresAt: installer.expiresAt,
      });
      this.pending.set(pending);
      return pending;
    } catch (error) {
      const message = error instanceof Error ? error.message : "media_agent_installer_failed";
      this.error.set(message);
      throw error;
    } finally {
      this.busy.set(false);
    }
  }

  async revoke(agentId: string): Promise<void> {
    if (!AGENT_ID_PATTERN.test(agentId)) throw new Error("media_agent_not_found");
    this.busy.set(true);
    this.error.set("");
    try {
      const response = await fetch(`/api/media-agents/${encodeURIComponent(agentId)}`, {
        method: "DELETE",
        headers: this.auth.authorizationHeader(),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "media_agent_revoke_failed");
      await this.load();
    } catch (error) {
      const message = error instanceof Error ? error.message : "media_agent_revoke_failed";
      this.error.set(message);
      throw error;
    } finally {
      this.busy.set(false);
    }
  }
}
