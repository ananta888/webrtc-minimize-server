import { InjectionToken } from "@angular/core";

export type BroadcastSourceKind = "microphone" | "camera" | "screen" | "screen-audio";
export type BroadcastAdapterKind = "whip" | "native-bridge" | "provider" | "mock";

export interface BroadcastProgramRef {
  readonly tenantId: string;
  readonly roomId: string;
  readonly programId: string;
  readonly programRevision: number;
  readonly programEpoch: number;
}

export interface BroadcastRoomSourceRef {
  readonly sourceId: string;
  readonly ownerSubjectRef: string;
  readonly kind: BroadcastSourceKind;
  readonly local: boolean;
  readonly active: boolean;
}

export interface BroadcastRoomPublicationSnapshot {
  readonly snapshotVersion: 1;
  readonly sessionInstanceId: string;
  readonly roomId: string;
  readonly publicationRevision: number;
  readonly sources: readonly BroadcastRoomSourceRef[];
}

export interface BroadcastStartPlan {
  readonly planVersion: 1;
  readonly trigger: "user-action";
  readonly program: BroadcastProgramRef;
  readonly roomPublication: BroadcastRoomPublicationSnapshot;
  readonly sourceIds: readonly string[];
  readonly adapterId: string;
}

export interface BroadcastConsentDecision {
  readonly decisionVersion: 1;
  readonly programEpoch: number;
  readonly sourceIds: readonly string[];
  readonly expiresAt: number;
}

export interface BroadcastConsentPort {
  authorize(
    program: BroadcastProgramRef,
    sources: readonly BroadcastRoomSourceRef[],
    signal: AbortSignal,
  ): Promise<BroadcastConsentDecision>;
}

export interface BroadcastCaptureForkHandle {
  readonly forkId: string;
  readonly sourceId: string;
  readonly kind: BroadcastSourceKind;
}

export interface BroadcastCaptureForkPort {
  fork(
    program: BroadcastProgramRef,
    source: BroadcastRoomSourceRef,
    publicationRevision: number,
    signal: AbortSignal,
  ): Promise<BroadcastCaptureForkHandle>;
  release(handle: BroadcastCaptureForkHandle): Promise<void>;
}

export interface BroadcastCompositionHandle {
  readonly compositionId: string;
  readonly sourceIds: readonly string[];
}

export interface BroadcastCompositionPort {
  compose(
    program: BroadcastProgramRef,
    forks: readonly BroadcastCaptureForkHandle[],
    signal: AbortSignal,
  ): Promise<BroadcastCompositionHandle>;
  release(handle: BroadcastCompositionHandle): Promise<void>;
}

export interface BroadcastPublicationCapability {
  readonly capabilityVersion: 1;
  readonly adapterId: string;
  readonly kind: BroadcastAdapterKind;
  readonly available: boolean;
  readonly ingestProtocols: readonly ("whip" | "native-bridge" | "provider" | "mock")[];
  readonly supportsAudio: boolean;
  readonly supportsVideo: boolean;
  readonly supportsSimulcast: boolean;
  readonly reasonCode?: string;
}

export interface BroadcastPublicationRequest {
  readonly requestVersion: 1;
  readonly program: BroadcastProgramRef;
  readonly composition: BroadcastCompositionHandle;
}

export interface BroadcastPublicationSession {
  readonly sessionId: string;
  readonly adapterId: string;
  readonly programId: string;
  readonly programEpoch: number;
}

export interface BroadcastPublicationPort {
  readonly capability: BroadcastPublicationCapability;
  start(request: BroadcastPublicationRequest, signal: AbortSignal): Promise<BroadcastPublicationSession>;
  stop(session: BroadcastPublicationSession, signal: AbortSignal): Promise<void>;
}

export interface BroadcastDeliveryCapabilityPort {
  list(): readonly BroadcastPublicationCapability[];
  require(adapterId: string): BroadcastPublicationPort;
}

export interface BroadcastPlaybackRequest {
  readonly requestVersion: 1;
  readonly trigger: "user-action";
  readonly programId: string;
  readonly programEpoch: number;
  readonly policyRevision: number;
}

export interface BroadcastPlaybackSession {
  readonly playbackSessionId: string;
  readonly programId: string;
  readonly programEpoch: number;
}

export interface BroadcastPlaybackPort {
  open(request: BroadcastPlaybackRequest, signal: AbortSignal): Promise<BroadcastPlaybackSession>;
  close(session: BroadcastPlaybackSession): Promise<void>;
}

export interface BroadcastStatsSample {
  readonly sampledAt: number;
  readonly outboundBitsPerSecond: number;
  readonly inboundBitsPerSecond: number;
  readonly droppedFrames: number;
}

export interface BroadcastStatsPort {
  subscribe(
    session: BroadcastPublicationSession,
    listener: (sample: BroadcastStatsSample) => void,
  ): () => void;
}

export interface BroadcastPublicationTransport {
  start(request: BroadcastPublicationRequest, signal: AbortSignal): Promise<BroadcastPublicationSession>;
  stop(session: BroadcastPublicationSession, signal: AbortSignal): Promise<void>;
}

export class BroadcastBrowserPortError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BroadcastBrowserPortError";
  }
}

export const BROADCAST_CONSENT_PORT = new InjectionToken<BroadcastConsentPort>("BROADCAST_CONSENT_PORT");
export const BROADCAST_CAPTURE_FORK_PORT = new InjectionToken<BroadcastCaptureForkPort>("BROADCAST_CAPTURE_FORK_PORT");
export const BROADCAST_COMPOSITION_PORT = new InjectionToken<BroadcastCompositionPort>("BROADCAST_COMPOSITION_PORT");
export const BROADCAST_PUBLICATION_ADAPTERS = new InjectionToken<readonly BroadcastPublicationPort[]>(
  "BROADCAST_PUBLICATION_ADAPTERS",
);
export const BROADCAST_PLAYBACK_PORT = new InjectionToken<BroadcastPlaybackPort>("BROADCAST_PLAYBACK_PORT");
export const BROADCAST_STATS_PORT = new InjectionToken<BroadcastStatsPort>("BROADCAST_STATS_PORT");
