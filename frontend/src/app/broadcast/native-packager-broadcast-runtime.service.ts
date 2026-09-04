import { Injectable } from "@angular/core";

import { cumulativeIceServers } from "../webrtc/ice-policy";
import { RoomSessionService } from "../webrtc/room-session.service";
import { ServerMessage, SignalingService } from "../webrtc/signaling.service";
import { BroadcastControlPlaneService, PreparedNativePackagerStart } from "./broadcast-control-plane.service";
import { BroadcastOwnSourceCompositionService } from "./broadcast-own-source-composition.service";
import { NativePackagerOnboardingService } from "./native-packager-onboarding.service";
import {
  BroadcastBrowserPortError,
  BroadcastPublicationCapability,
  BroadcastPublicationPort,
  BroadcastPublicationRequest,
  BroadcastPublicationSession,
  BroadcastStatsPort,
  BroadcastStatsSample,
} from "./broadcast-ports";

interface NativeSession {
  readonly publicSession: BroadcastPublicationSession;
  readonly assignment: PreparedNativePackagerStart;
  readonly pc: RTCPeerConnection;
  unsubscribe: () => void;
  pendingCandidates: RTCIceCandidateInit[];
  signalTask: Promise<void>;
  outputReady: Promise<void>;
  resolveOutput: () => void;
  rejectOutput: (error: unknown) => void;
  stopped: boolean;
}

function exactSignal(message: ServerMessage, assignment: PreparedNativePackagerStart): boolean {
  const fields = new Set([
    "version", "type", "packagerId", "assignmentId", "programId", "programEpoch",
    "fencingRevision", "description", "candidate",
  ]);
  const hasDescription = Object.hasOwn(message, "description");
  const hasCandidate = Object.hasOwn(message, "candidate");
  return message.type === "native-packager-signal" && message.version === 1
    && Object.keys(message).every((field) => fields.has(field)) && hasDescription !== hasCandidate
    && message["packagerId"] === assignment.packagerId
    && message["assignmentId"] === assignment.assignmentId
    && message["programId"] === assignment.programId
    && message["programEpoch"] === assignment.programEpoch
    && message["fencingRevision"] === assignment.fencingRevision;
}

function abortError(): DOMException { return new DOMException("native-packager-start-aborted", "AbortError"); }

function exactStatus(message: ServerMessage, assignment: PreparedNativePackagerStart): boolean {
  const fields = new Set([
    "version", "type", "packagerId", "assignmentId", "programId", "programEpoch",
    "fencingRevision", "state", "reasonCode", "observedAt",
  ]);
  return message.type === "native-packager-status" && message.version === 1
    && Object.keys(message).length === fields.size
    && Object.keys(message).every((field) => fields.has(field))
    && message["packagerId"] === assignment.packagerId
    && message["assignmentId"] === assignment.assignmentId
    && message["programId"] === assignment.programId
    && message["programEpoch"] === assignment.programEpoch
    && message["fencingRevision"] === assignment.fencingRevision
    && typeof message["state"] === "string" && typeof message["reasonCode"] === "string"
    && Number.isSafeInteger(message["observedAt"]);
}

@Injectable({ providedIn: "root" })
export class NativePackagerBroadcastRuntimeService implements BroadcastPublicationPort, BroadcastStatsPort {
  private readonly sessions = new Map<string, NativeSession>();

  constructor(
    private readonly control: BroadcastControlPlaneService,
    private readonly composition: BroadcastOwnSourceCompositionService,
    private readonly onboarding: NativePackagerOnboardingService,
    private readonly room: RoomSessionService,
    private readonly signaling: SignalingService,
  ) {}

  get capability(): BroadcastPublicationCapability {
    const selected = this.onboarding.selectedPackagerId();
    const available = this.room.joined() && Boolean(selected)
      && this.onboarding.eligible(this.room.roomId()).some(({ id }) => id === selected);
    return Object.freeze({
      capabilityVersion: 1,
      adapterId: "native-bridge",
      kind: "native-bridge",
      available,
      ingestProtocols: Object.freeze(["native-bridge" as const]),
      supportsAudio: true,
      supportsVideo: true,
      supportsSimulcast: false,
      ...(available ? {} : { reasonCode: "native-bridge-not-ready" }),
    });
  }

  async start(request: BroadcastPublicationRequest, signal: AbortSignal): Promise<BroadcastPublicationSession> {
    signal.throwIfAborted();
    if (!this.capability.available) throw new BroadcastBrowserPortError("native-bridge-not-ready");
    const policy = this.room.icePolicy();
    if (!policy || request.program.roomId !== this.room.roomId()) {
      throw new BroadcastBrowserPortError("native-packager-room-session-required");
    }
    const assignment = this.control.takePreparedNative(request.program);
    const media = await this.composition.resolve(request.composition, signal);
    const pc = new RTCPeerConnection({ iceServers: [...cumulativeIceServers(policy, 2)] });
    const publicSession = Object.freeze({
      sessionId: assignment.assignmentId,
      adapterId: "native-bridge",
      programId: request.program.programId,
      programEpoch: request.program.programEpoch,
    });
    let resolveOutput: () => void = () => undefined;
    let rejectOutput: (error: unknown) => void = () => undefined;
    const outputReady = new Promise<void>((resolve, reject) => {
      resolveOutput = resolve;
      rejectOutput = reject;
    });
    void outputReady.catch(() => undefined);
    const native: NativeSession = {
      publicSession, assignment, pc, pendingCandidates: [], signalTask: Promise.resolve(), stopped: false,
      outputReady, resolveOutput, rejectOutput,
      unsubscribe: () => undefined,
    };
    native.unsubscribe = this.signaling.subscribe((message) => this.acceptSignal(native, message));
    this.sessions.set(publicSession.sessionId, native);
    const fail = async (error: unknown): Promise<never> => {
      await this.close(native, true);
      throw error;
    };
    try {
      for (const descriptor of media.tracks) pc.addTrack(descriptor.track, media.stream);
      pc.onicecandidate = ({ candidate }) => {
        if (!native.stopped) this.sendSignal(assignment, { candidate: candidate?.toJSON() ?? null });
      };
      const connected = this.waitForConnected(pc, signal);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!pc.localDescription) throw new BroadcastBrowserPortError("native-packager-offer_failed");
      this.sendSignal(assignment, { description: pc.localDescription.toJSON() });
      await connected;
      await this.waitForOutput(native, signal);
      signal.throwIfAborted();
      return publicSession;
    } catch (error) {
      return fail(error);
    }
  }

  async stop(session: BroadcastPublicationSession, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const native = this.sessions.get(session.sessionId);
    if (!native) return;
    await this.close(native, true, signal);
  }

  subscribe(session: BroadcastPublicationSession, listener: (sample: BroadcastStatsSample) => void): () => void {
    const native = this.sessions.get(session.sessionId);
    if (!native) throw new BroadcastBrowserPortError("native-packager-session-not-found");
    let active = true;
    let previousBytes = 0;
    let previousAt = performance.now();
    const sample = async () => {
      if (!active || native.stopped) return;
      let bytes = 0;
      let droppedFrames = 0;
      (await native.pc.getStats()).forEach((report) => {
        if (report.type !== "outbound-rtp" || report.isRemote) return;
        bytes += Number(report.bytesSent || 0);
        droppedFrames += Number(report.framesDropped || 0);
      });
      const now = performance.now();
      const bitsPerSecond = previousBytes && now > previousAt
        ? Math.max(0, Math.round(((bytes - previousBytes) * 8_000) / (now - previousAt))) : 0;
      previousBytes = bytes;
      previousAt = now;
      listener(Object.freeze({ sampledAt: Date.now(), outboundBitsPerSecond: bitsPerSecond,
        inboundBitsPerSecond: 0, droppedFrames: Math.max(0, Math.round(droppedFrames)) }));
    };
    const handle = setInterval(() => { void sample(); }, 2_000);
    void sample();
    return () => { active = false; clearInterval(handle); };
  }

  private acceptSignal(native: NativeSession, message: ServerMessage): void {
    if (native.stopped || (message.type !== "native-packager-signal" && message.type !== "native-packager-status")) return;
    if (message.type === "native-packager-status") {
      if (!exactStatus(message, native.assignment)) {
        native.rejectOutput(new BroadcastBrowserPortError("invalid_native_packager_status"));
        void this.close(native, true);
        return;
      }
      if (message["state"] === "running" && message["reasonCode"] === "OUTPUT_READY") {
        native.resolveOutput();
      } else if (new Set(["draining", "stopped", "failed"]).has(String(message["state"]))) {
        native.rejectOutput(new BroadcastBrowserPortError(String(message["reasonCode"])));
      }
      return;
    }
    if (!exactSignal(message, native.assignment)) {
      void this.close(native, true);
      return;
    }
    native.signalTask = native.signalTask.then(async () => {
      if (Object.hasOwn(message, "description")) {
        const description = message["description"] as Partial<RTCSessionDescriptionInit> | null;
        if (!description || Object.keys(description).some((field) => !new Set(["type", "sdp"]).has(field))
          || description.type !== "answer" || typeof description.sdp !== "string"
          || description.sdp.length > 80_000 || native.pc.remoteDescription) {
          throw new BroadcastBrowserPortError("invalid_native_packager_answer");
        }
        await native.pc.setRemoteDescription({ type: "answer", sdp: description.sdp });
        for (const candidate of native.pendingCandidates) await native.pc.addIceCandidate(candidate);
        native.pendingCandidates = [];
        return;
      }
      const value = message["candidate"];
      const candidateValue = value as RTCIceCandidateInit | null;
      if (candidateValue !== null && (!candidateValue || typeof candidateValue !== "object" || Array.isArray(candidateValue)
        || Object.keys(candidateValue).some((field) => !new Set([
          "candidate", "sdpMid", "sdpMLineIndex", "usernameFragment",
        ]).has(field))
        || typeof candidateValue.candidate !== "string"
        || candidateValue.candidate.length > 4_096)) {
        throw new BroadcastBrowserPortError("invalid_native_packager_candidate");
      }
      const candidate = (value || { candidate: "" }) as RTCIceCandidateInit;
      if (!native.pc.remoteDescription) {
        if (native.pendingCandidates.length >= 128) throw new BroadcastBrowserPortError("native_packager_candidate_queue_full");
        native.pendingCandidates.push(candidate);
      } else {
        await native.pc.addIceCandidate(candidate);
      }
    }).catch(() => { void this.close(native, true); });
  }

  private async waitForOutput(native: NativeSession, signal: AbortSignal): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const boundary = new Promise<void>((_, reject) => {
      timeout = setTimeout(() => reject(new BroadcastBrowserPortError("native-packager-output-timeout")), 30_000);
      abort = () => reject(abortError());
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.race([native.outputReady, boundary]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abort) signal.removeEventListener("abort", abort);
    }
  }

  private sendSignal(assignment: PreparedNativePackagerStart, payload: { description: RTCSessionDescriptionInit } | { candidate: RTCIceCandidateInit | null }): void {
    this.signaling.send({
      version: 1, type: "native-packager-signal", packagerId: assignment.packagerId,
      assignmentId: assignment.assignmentId, programId: assignment.programId,
      programEpoch: assignment.programEpoch, fencingRevision: assignment.fencingRevision, ...payload,
    });
  }

  private waitForConnected(pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new BroadcastBrowserPortError("native-packager-connection-timeout")), 20_000);
      const abort = () => finish(abortError());
      const changed = () => {
        if (pc.connectionState === "connected") finish();
        else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          finish(new BroadcastBrowserPortError("native-packager-connection-failed"));
        }
      };
      const finish = (error?: unknown) => {
        clearTimeout(timeout); signal.removeEventListener("abort", abort); pc.removeEventListener("connectionstatechange", changed);
        if (error) reject(error); else resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
      pc.addEventListener("connectionstatechange", changed);
      changed();
    });
  }

  private async close(native: NativeSession, stopRemote: boolean, signal = new AbortController().signal): Promise<void> {
    if (native.stopped) return;
    native.stopped = true;
    native.rejectOutput(new BroadcastBrowserPortError("native-packager-session-stopped"));
    native.unsubscribe();
    native.pc.onicecandidate = null;
    native.pc.close();
    native.pendingCandidates = [];
    this.sessions.delete(native.publicSession.sessionId);
    if (stopRemote) await this.control.stopNativeAssignment(native.assignment, signal);
  }
}
