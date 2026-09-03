import {
  BroadcastAdapterKind,
  BroadcastBrowserPortError,
  BroadcastPublicationCapability,
  BroadcastPublicationPort,
  BroadcastPublicationRequest,
  BroadcastPublicationSession,
  BroadcastPublicationTransport,
} from "./broadcast-ports";

const ADAPTER_ID = /^[a-z][a-z0-9-]{2,63}$/;
const REASON_CODE = /^[a-z][a-z0-9-]{2,63}$/;

interface AdapterOptions {
  readonly adapterId: string;
  readonly kind: BroadcastAdapterKind;
  readonly ingestProtocol: "whip" | "native-bridge" | "provider" | "mock";
  readonly supportsAudio: boolean;
  readonly supportsVideo: boolean;
  readonly supportsSimulcast: boolean;
  readonly unavailableReason: string;
  readonly transport?: BroadcastPublicationTransport;
}

class TransportBackedPublicationAdapter implements BroadcastPublicationPort {
  readonly capability: BroadcastPublicationCapability;
  private readonly activeSessions = new Set<string>();

  constructor(
    private readonly options: AdapterOptions,
  ) {
    if (!ADAPTER_ID.test(options.adapterId) || !REASON_CODE.test(options.unavailableReason)) {
      throw new BroadcastBrowserPortError("invalid_broadcast_adapter_configuration");
    }
    this.capability = Object.freeze({
      capabilityVersion: 1,
      adapterId: options.adapterId,
      kind: options.kind,
      available: Boolean(options.transport),
      ingestProtocols: Object.freeze([options.ingestProtocol]),
      supportsAudio: options.supportsAudio,
      supportsVideo: options.supportsVideo,
      supportsSimulcast: options.supportsSimulcast,
      ...(options.transport ? {} : { reasonCode: options.unavailableReason }),
    });
  }

  async start(
    request: BroadcastPublicationRequest,
    signal: AbortSignal,
  ): Promise<BroadcastPublicationSession> {
    signal.throwIfAborted();
    if (!this.options.transport || !this.capability.available) {
      throw new BroadcastBrowserPortError(this.capability.reasonCode || "broadcast_adapter_unavailable");
    }
    const session = await this.options.transport.start(request, signal);
    if (!session || session.adapterId !== this.capability.adapterId
      || session.programId !== request.program.programId
      || session.programEpoch !== request.program.programEpoch
      || typeof session.sessionId !== "string" || session.sessionId.length < 8
      || this.activeSessions.has(session.sessionId)) {
      throw new BroadcastBrowserPortError("invalid_broadcast_publication_session");
    }
    if (signal.aborted) {
      await this.options.transport.stop(session, new AbortController().signal);
      signal.throwIfAborted();
    }
    this.activeSessions.add(session.sessionId);
    return Object.freeze({ ...session });
  }

  async stop(session: BroadcastPublicationSession, signal: AbortSignal): Promise<void> {
    if (!this.activeSessions.has(session.sessionId)) return;
    if (!this.options.transport) {
      throw new BroadcastBrowserPortError("broadcast_adapter_unavailable");
    }
    await this.options.transport.stop(session, signal);
    this.activeSessions.delete(session.sessionId);
  }
}

export class WhipBroadcastPublicationAdapter extends TransportBackedPublicationAdapter {
  constructor(transport?: BroadcastPublicationTransport) {
    super({
      adapterId: "whip-browser",
      kind: "whip",
      ingestProtocol: "whip",
      supportsAudio: true,
      supportsVideo: true,
      supportsSimulcast: false,
      unavailableReason: "whip-not-configured",
      transport,
    });
  }
}

export class NativeBridgeBroadcastPublicationAdapter extends TransportBackedPublicationAdapter {
  constructor(transport?: BroadcastPublicationTransport) {
    super({
      adapterId: "native-bridge",
      kind: "native-bridge",
      ingestProtocol: "native-bridge",
      supportsAudio: true,
      supportsVideo: true,
      supportsSimulcast: false,
      unavailableReason: "native-bridge-not-configured",
      transport,
    });
  }
}

export class ProviderBroadcastPublicationAdapter extends TransportBackedPublicationAdapter {
  constructor(
    adapterId: string,
    transport?: BroadcastPublicationTransport,
    options: Readonly<{
      supportsAudio?: boolean;
      supportsVideo?: boolean;
      supportsSimulcast?: boolean;
    }> = {},
  ) {
    super({
      adapterId,
      kind: "provider",
      ingestProtocol: "provider",
      supportsAudio: options.supportsAudio === true,
      supportsVideo: options.supportsVideo === true,
      supportsSimulcast: options.supportsSimulcast === true,
      unavailableReason: "provider-not-configured",
      transport,
    });
  }
}

export class MockBroadcastPublicationAdapter extends TransportBackedPublicationAdapter {
  readonly starts: BroadcastPublicationRequest[];
  readonly stops: BroadcastPublicationSession[];

  constructor(adapterId = "mock-broadcast") {
    const starts: BroadcastPublicationRequest[] = [];
    const stops: BroadcastPublicationSession[] = [];
    let sequence = 0;
    const transport: BroadcastPublicationTransport = {
      async start(request, signal) {
        signal.throwIfAborted();
        starts.push(request);
        sequence += 1;
        return {
          sessionId: `mock-session-${sequence}`,
          adapterId,
          programId: request.program.programId,
          programEpoch: request.program.programEpoch,
        };
      },
      async stop(session) {
        stops.push(session);
      },
    };
    super({
      adapterId,
      kind: "mock",
      ingestProtocol: "mock",
      supportsAudio: true,
      supportsVideo: true,
      supportsSimulcast: true,
      unavailableReason: "mock-not-configured",
      transport,
    });
    this.starts = starts;
    this.stops = stops;
  }
}
