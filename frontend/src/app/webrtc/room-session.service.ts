import { Injectable, signal } from "@angular/core";

import { OidcAuthService } from "../auth/oidc-auth.service";
import { RuntimeConfigService } from "../core/runtime-config.service";
import { DeviceIdentityService } from "../identity/device-identity.service";
import { IceTierPolicy, parseIceTierPolicy } from "./ice-policy";
import { PeerMeshService } from "./peer-mesh.service";
import { ServerMessage, SignalingService } from "./signaling.service";

export type RoomMode = "room" | "pair";

interface SessionResponse {
  readonly signalingPath: string;
  readonly iceServers: readonly RTCIceServer[];
  readonly icePolicy: unknown;
  readonly identity: Readonly<{ authenticated: boolean; displayName?: string }>;
  readonly workspace?: Readonly<{ workspaceId: string; role: "owner" | "editor" | "viewer" }> | null;
}

@Injectable({ providedIn: "root" })
export class RoomSessionService {
  readonly joined = signal(false);
  readonly roomId = signal("");
  readonly mode = signal<RoomMode>("room");
  readonly displayName = signal("");
  readonly maxParticipants = signal(20);
  readonly error = signal("");
  readonly inviteUrl = signal("");
  readonly workspaceId = signal("");
  readonly workspaceRole = signal<"owner" | "editor" | "viewer" | "">("");
  readonly roomCreator = signal(false);
  private workspaceInvite = "";

  constructor(
    private readonly config: RuntimeConfigService,
    private readonly auth: OidcAuthService,
    private readonly device: DeviceIdentityService,
    private readonly signaling: SignalingService,
    private readonly mesh: PeerMeshService,
  ) {}

  async createRoom(mode: RoomMode, persistent = false, title = ""): Promise<{ roomId: string; inviteUrl: string; workspaceId?: string }> {
    this.error.set("");
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json", ...this.auth.authorizationHeader() },
      body: JSON.stringify({ mode, ...(persistent ? { persistent: true, title } : {}) }),
    });
    const body = await response.json() as { roomId?: string; inviteUrl?: string; workspaceId?: string; role?: "owner"; error?: string };
    if (!response.ok || !body.roomId || !body.inviteUrl) throw new Error(body.error || "room_creation_failed");
    this.roomId.set(body.roomId);
    this.mode.set(mode);
    this.inviteUrl.set(body.inviteUrl);
    this.workspaceId.set(body.workspaceId || "");
    this.workspaceRole.set(body.role || "");
    this.workspaceInvite = new URL(body.inviteUrl).searchParams.get("workspaceInvite") || "";
    return { roomId: body.roomId, inviteUrl: body.inviteUrl, workspaceId: body.workspaceId };
  }

  setWorkspaceInvite(value: string): void {
    this.workspaceInvite = value.slice(0, 128);
  }

  async join(roomId: string, displayName: string, mode: RoomMode): Promise<void> {
    this.leave();
    this.error.set("");
    const normalizedRoom = roomId.trim().toLowerCase();
    const normalizedName = displayName.trim().replace(/\s+/g, " ");
    try {
      const deviceProof = await this.device.createProof({ roomId: normalizedRoom, mode, displayName: normalizedName });
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", ...this.auth.authorizationHeader() },
        body: JSON.stringify({
          roomId: normalizedRoom,
          displayName: normalizedName,
          mode,
          deviceProof,
          ...(this.workspaceInvite ? { workspaceInvite: this.workspaceInvite } : {}),
        }),
      });
      const body = await response.json() as SessionResponse & { error?: string };
      const icePolicy = parseIceTierPolicy(body.icePolicy);
      if (!response.ok || !body.signalingPath || !Array.isArray(body.iceServers) || !icePolicy) {
        throw new Error(body.error || "session_authorization_failed");
      }
      this.roomId.set(normalizedRoom);
      const authorizedName = body.identity?.authenticated && body.identity.displayName
        ? body.identity.displayName
        : normalizedName;
      this.displayName.set(authorizedName);
      this.mode.set(mode);
      this.maxParticipants.set(mode === "pair" ? 2 : (this.config.value()?.maxRoomParticipants || 20));
      this.inviteUrl.set(`${location.origin}/?room=${encodeURIComponent(normalizedRoom)}&mode=${mode}`
        + (this.workspaceInvite ? `&workspaceInvite=${encodeURIComponent(this.workspaceInvite)}` : ""));
      this.workspaceId.set(body.workspace?.workspaceId || "");
      this.workspaceRole.set(body.workspace?.role || "");
      this.signaling.connect(
        body.signalingPath,
        (message) => this.handleMessage(message, icePolicy),
        () => {
          this.mesh.close();
          this.joined.set(false);
        },
      );
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : "session_join_failed");
      throw error;
    }
  }

  leave(): void {
    this.signaling.close();
    this.mesh.close();
    this.joined.set(false);
    this.workspaceId.set("");
    this.workspaceRole.set("");
    this.roomCreator.set(false);
  }

  private handleMessage(message: ServerMessage, icePolicy: IceTierPolicy): void {
    if (message.type === "welcome") {
      const ownId = String(message["peerId"] || "");
      this.mesh.initialize(
        ownId,
        this.displayName(),
        this.roomId(),
        icePolicy,
        Array.isArray(message["mediaAgents"])
          ? message["mediaAgents"] as Array<{ id: string; online: boolean }>
          : [],
        this.config.value()?.optimization,
        this.config.value()?.mediaE2ee,
      );
      this.roomCreator.set(message["roomCreator"] === true);
      const peers = Array.isArray(message["peers"]) ? message["peers"] as Array<{ id: string; name: string }> : [];
      for (const peer of peers) this.mesh.addPeer(peer.id, peer.name);
      this.joined.set(true);
      this.mesh.announcePublications();
      return;
    }
    if (message.type === "peer-joined") {
      const peer = message["peer"] as { id?: string; name?: string };
      this.mesh.addPeer(String(peer?.id || ""), String(peer?.name || "Peer"));
      this.mesh.announcePublications();
      this.mesh.announceOverlayKey();
      return;
    }
    if (message.type === "peer-left") {
      this.mesh.removePeer(String(message["peerId"] || ""));
      return;
    }
    if (message.type === "signal") {
      void this.mesh.acceptSignal(message);
      return;
    }
    if (message.type === "media-state") {
      this.mesh.updateRemoteSource(message);
      return;
    }
    if (message.type === "topology-state") {
      this.mesh.applyTopology(message);
      return;
    }
    if (message.type === "media-agent-state") {
      this.mesh.applyMediaAgentState(message);
      return;
    }
    if (message.type === "media-agent-availability") {
      this.mesh.applyMediaAgentAvailability(message);
      return;
    }
    if (message.type === "media-agent-takeover-request") {
      this.mesh.applyMediaAgentTakeoverRequest(message);
      return;
    }
    if (message.type === "media-agent-signal") {
      void this.mesh.acceptMediaAgentSignal(message);
      return;
    }
    if (message.type === "media-agent-track-state") {
      this.mesh.applyMediaAgentTrackState(message);
      return;
    }
    if (message.type === "media-agent-subscription-state") {
      this.mesh.applyMediaAgentSubscriptionState(message);
      return;
    }
    if (message.type === "overlay-key") {
      void this.mesh.acceptOverlayKey(message);
      return;
    }
    if (message.type === "error") {
      this.error.set(String(message["code"] || "signaling_error"));
    }
  }
}
