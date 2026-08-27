import { Injectable, signal } from "@angular/core";

export type AuthMode = "disabled" | "optional" | "required";

export interface RuntimeConfig {
  readonly iceServers: readonly RTCIceServer[];
  readonly maxRoomParticipants: number;
  readonly pairParticipants: number;
  readonly turnConfigured: boolean;
  readonly auth: Readonly<{
    mode: AuthMode;
    issuer: string;
    clientId: string;
    audience: string;
  }>;
}
@Injectable({ providedIn: "root" })
export class RuntimeConfigService {
  readonly value = signal<RuntimeConfig | null>(null);

  async load(): Promise<RuntimeConfig> {
    const response = await fetch("/config", { credentials: "same-origin" });
    if (!response.ok) throw new Error("runtime_config_unavailable");
    const config = await response.json() as RuntimeConfig;
    if (!config.auth || !Array.isArray(config.iceServers)) throw new Error("runtime_config_invalid");
    this.value.set(config);
    return config;
  }
}
