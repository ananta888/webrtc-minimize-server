import { Injectable, signal } from "@angular/core";

import { OidcAuthService } from "../auth/oidc-auth.service";
import { RuntimeConfigService } from "../core/runtime-config.service";
import { DeviceIdentityService } from "../identity/device-identity.service";
import { MachineSessionContext, MachineSessionLease, parseMachineSessionContext, parseMachineSessionLease } from "./machine-session-contract";
import { IceTierPolicy, parseIceTierPolicy } from "./ice-policy";
import { PeerMeshService } from "./peer-mesh.service";
import { ServerMessage, SignalingService } from "./signaling.service";

export type RoomMode = "room" | "pair";

interface SessionResponse {
  readonly machineExpiresAt?: number;
  readonly machineLease?: unknown;
  readonly machineContext?: unknown;
  readonly signalingPath: string;
  readonly iceServers: readonly RTCIceServer[];
  readonly icePolicy: unknown;
  readonly identity: Readonly<{ authenticated: boolean; displayName?: string }>;
  readonly workspace?: Readonly<{ workspaceId: string; role: "owner" | "editor" | "viewer" }> | null;
}

@Injectable({ providedIn: "root" })
export class RoomSessionService {
  readonly joined = signal(false);
  readonly peerId = signal("");
  readonly roomId = signal("");
  readonly mode = signal<RoomMode>("room");
  readonly displayName = signal("");
  readonly maxParticipants = signal(20);
  readonly error = signal("");
  readonly inviteUrl = signal("");
  readonly workspaceId = signal("");
  readonly workspaceRole = signal<"owner" | "editor" | "viewer" | "">("");
  readonly roomCreator = signal(false);
  readonly icePolicy = signal<IceTierPolicy | null>(null);
  readonly machineExpiresAt = signal(0);
  readonly machineLease = signal<MachineSessionLease | null>(null);
  readonly machineContext = signal<MachineSessionContext | null>(null);
  private machineRenewal: AbortController | null = null;
  private joinOperation: AbortController | null = null;
  private sessionGeneration = 0;
  private cleanupUnconfirmed = false;
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

  async join(roomId: string, displayName: string, mode: RoomMode, machineGrant?: string): Promise<void> {
    if (!this.leave()) throw new Error("session_cleanup_failed");
    const generation = this.sessionGeneration;
    const controller = new AbortController();
    this.joinOperation = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    this.error.set("");
    const normalizedRoom = roomId.trim().toLowerCase();
    const normalizedName = displayName.trim().replace(/\s+/g, " ");
    try {
      const deviceProof = await this.device.createProof({ roomId: normalizedRoom, mode, displayName: normalizedName });
      signal.throwIfAborted();
      const response = await fetch(machineGrant ? "/api/machine/sessions" : "/api/sessions", {
        method: "POST",
        signal, credentials: "same-origin", redirect: "error",
        headers: { "content-type": "application/json", ...(machineGrant
          ? { Authorization: `Bearer ${machineGrant}` } : this.auth.authorizationHeader()) },
        body: JSON.stringify({
          roomId: normalizedRoom,
          displayName: normalizedName,
          mode,
          deviceProof,
          machineReceiveVersion: 1,
          ...(this.workspaceInvite ? { workspaceInvite: this.workspaceInvite } : {}),
        }),
      });
      const body = await response.json() as SessionResponse & { error?: string };
      signal.throwIfAborted();
      if (generation !== this.sessionGeneration) throw new Error("session_join_cancelled");
      const icePolicy = parseIceTierPolicy(body.icePolicy);
      if (!response.ok || !body.signalingPath || !Array.isArray(body.iceServers) || !icePolicy) {
        throw new Error(body.error || "session_authorization_failed");
      }
      if (machineGrant && (!Number.isSafeInteger(body.machineExpiresAt)
          || Number(body.machineExpiresAt) <= Date.now() || Number(body.machineExpiresAt) > Date.now() + 600_000
          || this.config.value()?.mediaE2ee.mode !== "required")) {
        throw new Error("machine_session_policy_invalid");
      }
      this.machineExpiresAt.set(body.machineExpiresAt || 0);
      if (machineGrant && body.machineLease) {
        const lease = parseMachineSessionLease(body.machineLease);
        if (lease.expiresAt !== body.machineExpiresAt || lease.generation !== 1) throw new Error("machine_session_policy_invalid");
        this.machineLease.set(lease);
      }
      if (machineGrant && body.machineContext !== undefined) this.machineContext.set(parseMachineSessionContext(body.machineContext));
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
      this.icePolicy.set(icePolicy);
      this.signaling.connect(
        body.signalingPath,
        (message) => { if (generation === this.sessionGeneration) this.handleMessage(message, icePolicy); },
        () => {
          if (generation !== this.sessionGeneration) return;
          this.cancelMachineRenewal();
          this.machineExpiresAt.set(0);
          this.joined.set(false);
          this.peerId.set("");
          this.icePolicy.set(null);
          this.closeMesh();
        },
      );
    } catch (error) {
      if (generation === this.sessionGeneration) {
        this.cancelMachineRenewal(); this.machineExpiresAt.set(0);
        this.error.set(error instanceof Error ? error.message : "session_join_failed");
      }
      throw error;
    } finally { if (this.joinOperation === controller) this.joinOperation = null; }
  }

  async renewMachine(grant: string): Promise<MachineSessionLease> {
    const previous = this.machineLease();
    if (!this.joined() || !previous || previous.expiresAt <= Date.now() || this.machineRenewal
      || typeof grant !== "string" || !grant || grant.length > 4096) throw new Error("machine_renewal_unavailable");
    const controller = new AbortController();
    this.machineRenewal = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    try {
      const roomId = this.roomId();
      const deviceProof = await this.device.createProof({ roomId, mode: "room", displayName: "Ananta (KI)",
        machineSessionId: previous.sessionId, expectedGeneration: previous.generation });
      signal.throwIfAborted();
      const response = await fetch("/api/machine/sessions/renew", { method: "POST", credentials: "same-origin",
        redirect: "error", signal, headers: { "content-type": "application/json", Authorization: `Bearer ${grant}` },
        body: JSON.stringify({ roomId, sessionId: previous.sessionId, expectedGeneration: previous.generation, deviceProof }) });
      if (!response.ok) throw new Error("machine_renewal_denied");
      const next = parseMachineSessionLease(await response.json());
      signal.throwIfAborted();
      if (!this.joined() || this.machineLease() !== previous || next.sessionId !== previous.sessionId
        || next.generation !== previous.generation + 1 || next.absoluteExpiresAt !== previous.absoluteExpiresAt
        || next.expiresAt <= previous.expiresAt) throw new Error("machine_renewal_scope_changed");
      this.machineLease.set(next); this.machineExpiresAt.set(next.expiresAt);
      return next;
    } catch (error) {
      // Unknown renewal outcome is not permission to continue on a stale local lease.
      if (this.machineLease() === previous) this.leave();
      throw error;
    } finally { if (this.machineRenewal === controller) this.machineRenewal = null; }
  }

  private cancelMachineRenewal(): void {
    this.machineRenewal?.abort(); this.machineRenewal = null; this.machineLease.set(null);
    this.machineContext.set(null);
  }

  /** False remains sticky: a detached handle's later no-op is not a stop ACK. */
  leave(): boolean {
    ++this.sessionGeneration;
    this.joinOperation?.abort(); this.joinOperation = null;
    this.cancelMachineRenewal();
    this.machineExpiresAt.set(0);
    this.joined.set(false);
    this.peerId.set("");
    this.workspaceId.set("");
    this.workspaceRole.set("");
    this.roomCreator.set(false);
    this.icePolicy.set(null);
    let cleanupFailed = false;
    try {
      this.signaling.leave();
    } catch {
      cleanupFailed = true;
    }
    this.closeMesh();
    this.cleanupUnconfirmed ||= cleanupFailed;
    if (this.cleanupUnconfirmed) this.error.set("session_cleanup_failed");
    return !this.cleanupUnconfirmed;
  }

  private closeMesh(): void {
    try { this.mesh.close(); }
    catch {
      this.cleanupUnconfirmed = true;
      this.error.set("session_cleanup_failed");
    }
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
      const peers = Array.isArray(message["peers"]) ? message["peers"] as Array<{ id: string; name: string; machine?: boolean; machineCapabilities?: unknown }> : [];
      this.mesh.machineReceive.setMachine(String(message["peerId"] || ""), message["machine"] === true, message["machineCapabilities"]);
      for (const peer of peers) this.mesh.addPeer(peer.id, peer.name, peer.machine === true, peer.machineCapabilities);
      this.joined.set(true);
      this.peerId.set(ownId);
      this.mesh.announcePublications();
      return;
    }
    if (message.type === "peer-joined") {
      const peer = message["peer"] as { id?: string; name?: string; machine?: boolean; machineCapabilities?: unknown };
      this.mesh.addPeer(String(peer?.id || ""), String(peer?.name || "Peer"), peer?.machine === true, peer?.machineCapabilities);
      this.mesh.announcePublications();
      this.mesh.announceOverlayKey();
      return;
    }
    if (message.type === "peer-left") {
      this.mesh.machineReceive.removePeer(String(message["peerId"] || ""));
      this.mesh.removePeer(String(message["peerId"] || ""));
      return;
    }
    if (message.type === "machine-receive-state") {
      this.mesh.machineReceive.apply(message, this.roomId());
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
