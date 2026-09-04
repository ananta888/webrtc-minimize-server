import {
  BroadcastBrowserPortError,
  BroadcastPublicationRequest,
  BroadcastPublicationSession,
  BroadcastPublicationTransport,
} from "./broadcast-ports";
import {
  NormalizedWhipRuntimeConfiguration,
  WhipAction,
  WhipAuthorizationPort,
  WhipMediaTrackDescriptor,
  WhipMediaStreamPort,
  WhipResolvedMedia,
  WhipRuntimeConfiguration,
  WhipSessionLifecycle,
  assertWhipResourceUrl,
  normalizeWhipAuthorization,
  normalizeWhipResolvedMedia,
  normalizeWhipRuntimeConfiguration,
} from "./whip-contracts";
import {
  WhipIceCandidate,
  applyWhipIceRestartAnswer,
  createWhipIceFragment,
  prepareWhipOffer,
  validateWhipAnswer,
} from "./whip-sdp";
import {
  DEFAULT_WHIP_SENDER_POLICY,
  WhipAdaptationSample,
  WhipAdaptiveSenderController,
  WhipSenderBinding,
  WhipSenderPolicy,
  WhipSenderQualityLevel,
} from "./whip-sender-controller";

export interface WhipPeerConnectionFactory {
  create(configuration: RTCConfiguration): RTCPeerConnection;
  capabilities(kind: "audio" | "video"): RTCRtpCapabilities | null;
}

export interface WhipSessionStatus {
  readonly lifecycle: WhipSessionLifecycle;
  readonly errorCode: string;
  readonly restartAttempts: number;
  readonly qualityLevel: WhipSenderQualityLevel | null;
  readonly adaptationReason: string;
}

export interface Rfc9725WhipTransportDependencies {
  readonly authorization: WhipAuthorizationPort;
  readonly media: WhipMediaStreamPort;
  readonly peerConnections?: WhipPeerConnectionFactory;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly allowLoopbackHttpForTests?: boolean;
  readonly senderPolicy?: WhipSenderPolicy;
  readonly scheduleAdaptation?: boolean;
}

interface ActiveWhipSession {
  readonly session: BroadcastPublicationSession;
  readonly program: BroadcastPublicationRequest["program"];
  readonly peerConnection: RTCPeerConnection;
  readonly resourceUrl: string;
  request: BroadcastPublicationRequest;
  media: WhipResolvedMedia;
  bindings: readonly WhipSenderBinding[];
  senderController: WhipAdaptiveSenderController;
  adaptationTimer: ReturnType<typeof setInterval> | null;
  adaptationRunning: boolean;
  adaptationReason: string;
  trackListeners: ReadonlyMap<MediaStreamTrack, () => void>;
  etag: string | null;
  lifecycle: WhipSessionLifecycle;
  errorCode: string;
  restartAttempts: number;
  stopTask: Promise<void> | null;
  connectionListener: () => void;
}

interface HttpResult {
  readonly response: Response;
  readonly requestUrl: string;
}

const SDP_CONTENT_TYPE = "application/sdp";
const ICE_CONTENT_TYPE = "application/trickle-ice-sdpfrag";
const STRONG_ETAG = /^"[\x21\x23-\x7e]{1,256}"$/;

function fail(code: string): never {
  throw new BroadcastBrowserPortError(code);
}

function randomSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `whip_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function contentType(response: Response): string {
  return (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function defaultDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const handle = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(handle);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function defaultPeerConnectionFactory(): WhipPeerConnectionFactory {
  return {
    create(configuration) {
      return new RTCPeerConnection(configuration);
    },
    capabilities(kind) {
      return RTCRtpReceiver.getCapabilities(kind);
    },
  };
}

function safeErrorCode(error: unknown, fallback: string): string {
  if (error instanceof BroadcastBrowserPortError) return error.code;
  if (isAbort(error)) return "whip_request_aborted";
  return fallback;
}

function statusError(response: Response): string {
  if (response.status === 301 || response.status === 302 || response.status === 303) {
    return "whip_unsafe_redirect";
  }
  if (response.status === 307 || response.status === 308) return "whip_redirect_not_followed";
  if (response.status === 401) return "whip_unauthorized";
  if (response.status === 403) return "whip_forbidden";
  if (response.status === 404 || response.status === 410) return "whip_session_lost";
  if (response.status === 412) return "whip_ice_precondition_failed";
  if (response.status === 428) return "whip_ice_precondition_required";
  if (response.status === 429) return "whip_rate_limited";
  if (response.status === 503) return "whip_gateway_unavailable";
  if (response.status >= 400 && response.status < 500) return "whip_request_rejected";
  if (response.status >= 500) return "whip_gateway_error";
  return "whip_unexpected_status";
}

function retryDelay(response: Response): number {
  const header = response.headers.get("retry-after");
  if (!header || !/^\d{1,3}$/.test(header)) return 100;
  return Math.min(1_000, Number(header) * 1_000);
}

async function readBoundedText(response: Response, maximumBytes: number, expectedType: string): Promise<string> {
  if (contentType(response) !== expectedType) fail("whip_invalid_content_type");
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    fail("whip_response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        fail("whip_response_too_large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("whip_invalid_response_encoding");
  }
}

function waitForState(
  peerConnection: RTCPeerConnection,
  state: "ice-gathering" | "connection",
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const complete = () => state === "ice-gathering"
    ? peerConnection.iceGatheringState === "complete"
    : peerConnection.connectionState === "connected";
  if (complete()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const eventName = state === "ice-gathering" ? "icegatheringstatechange" : "connectionstatechange";
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      peerConnection.removeEventListener(eventName, changed);
    };
    const succeed = () => {
      cleanup();
      resolve();
    };
    const rejectWith = (code: string) => {
      cleanup();
      reject(new BroadcastBrowserPortError(code));
    };
    const changed = () => {
      if (complete()) succeed();
      else if (state === "connection"
        && (peerConnection.connectionState === "failed" || peerConnection.connectionState === "closed")) {
        rejectWith("whip_connection_failed");
      }
    };
    const abort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => rejectWith(
      state === "ice-gathering" ? "whip_ice_gathering_timeout" : "whip_connection_timeout",
    ), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    peerConnection.addEventListener(eventName, changed);
    changed();
  });
}

function collectCandidates(
  peerConnection: RTCPeerConnection,
  maximumCandidates: number,
): Readonly<{
  candidates: WhipIceCandidate[];
  ended: () => boolean;
  overflowed: () => boolean;
  close: () => void;
}> {
  const candidates: WhipIceCandidate[] = [];
  let endOfCandidates = false;
  let overflow = false;
  const listener = (event: RTCPeerConnectionIceEvent) => {
    if (!event.candidate) {
      endOfCandidates = true;
      return;
    }
    const candidate = event.candidate.toJSON();
    if (!candidate.candidate) {
      endOfCandidates = true;
      return;
    }
    if (candidates.length >= maximumCandidates) {
      overflow = true;
      return;
    }
    candidates.push(Object.freeze({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    }));
  };
  peerConnection.addEventListener("icecandidate", listener);
  return Object.freeze({
    candidates,
    ended: () => endOfCandidates,
    overflowed: () => overflow,
    close: () => peerConnection.removeEventListener("icecandidate", listener),
  });
}

export class Rfc9725WhipTransport implements BroadcastPublicationTransport {
  private readonly configuration: NormalizedWhipRuntimeConfiguration;
  private readonly peerConnections: WhipPeerConnectionFactory;
  private readonly fetchRequest: typeof fetch;
  private readonly now: () => number;
  private readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly senderPolicy: WhipSenderPolicy;
  private readonly sessions = new Map<string, ActiveWhipSession>();
  private readonly sessionsByProgram = new Map<string, ActiveWhipSession>();
  private readonly startTasks = new Map<string, Promise<BroadcastPublicationSession>>();

  constructor(
    configuration: WhipRuntimeConfiguration,
    private readonly dependencies: Rfc9725WhipTransportDependencies,
  ) {
    this.configuration = normalizeWhipRuntimeConfiguration(configuration, {
      allowLoopbackHttp: dependencies.allowLoopbackHttpForTests === true,
    });
    this.peerConnections = dependencies.peerConnections || defaultPeerConnectionFactory();
    this.fetchRequest = dependencies.fetch || fetch.bind(globalThis);
    this.now = dependencies.now || Date.now;
    this.delay = dependencies.delay || defaultDelay;
    this.senderPolicy = dependencies.senderPolicy || DEFAULT_WHIP_SENDER_POLICY;
  }

  status(session: BroadcastPublicationSession): WhipSessionStatus {
    const active = this.sessions.get(session.sessionId);
    if (!active) return Object.freeze({
      lifecycle: "stopped",
      errorCode: "",
      restartAttempts: 0,
      qualityLevel: null,
      adaptationReason: "",
    });
    return Object.freeze({
      lifecycle: active.lifecycle,
      errorCode: active.errorCode,
      restartAttempts: active.restartAttempts,
      qualityLevel: active.senderController.level,
      adaptationReason: active.adaptationReason,
    });
  }

  async replaceComposition(
    session: BroadcastPublicationSession,
    composition: BroadcastPublicationRequest["composition"],
    signal: AbortSignal,
  ): Promise<BroadcastPublicationSession> {
    signal.throwIfAborted();
    const active = this.sessions.get(session.sessionId);
    if (!active || active.lifecycle === "stopped") fail("unknown_whip_session");
    const media = this.resolveMedia(composition, await this.dependencies.media.resolve(composition, signal));
    signal.throwIfAborted();
    const currentKinds = active.bindings.map(({ descriptor }) => descriptor.track.kind).sort().join(",");
    const replacementKinds = media.tracks.map(({ track }) => track.kind).sort().join(",");
    if (currentKinds !== replacementKinds) {
      const replacementRequest: BroadcastPublicationRequest = Object.freeze({
        requestVersion: 1,
        program: active.request.program,
        composition,
      });
      await this.stop(active.session, signal);
      return this.start(replacementRequest, signal);
    }
    const replacements = active.bindings.map((binding) => ({
      binding,
      descriptor: media.tracks.find(({ track }) => track.kind === binding.descriptor.track.kind)!,
    }));
    const completed: typeof replacements = [];
    try {
      for (const replacement of replacements) {
        if (replacement.binding.descriptor.envelope !== replacement.descriptor.envelope) {
          fail("whip_replacement_envelope_mismatch");
        }
        await replacement.binding.sender.replaceTrack(replacement.descriptor.track);
        completed.push(replacement);
      }
    } catch (error) {
      for (const replacement of completed.reverse()) {
        try {
          await replacement.binding.sender.replaceTrack(replacement.binding.descriptor.track);
        } catch {
          active.lifecycle = "failed";
          active.errorCode = "whip_replacement_rollback_failed";
        }
      }
      if (active.lifecycle !== "failed") {
        active.lifecycle = "degraded";
        active.errorCode = "whip_replacement_failed";
      }
      throw error instanceof BroadcastBrowserPortError
        ? error
        : new BroadcastBrowserPortError(active.errorCode);
    }
    this.removeTrackListeners(active);
    active.media = media;
    active.request = Object.freeze({ ...active.request, composition });
    active.bindings = Object.freeze(replacements.map(({ binding, descriptor }) => Object.freeze({
      sender: binding.sender,
      descriptor,
    })));
    const applied = await active.senderController.replaceBindings(active.bindings);
    this.installTrackListeners(active);
    active.lifecycle = applied ? "connected" : "degraded";
    active.errorCode = applied ? "" : "whip_sender_parameters_degraded";
    active.adaptationReason = "source-replaced";
    return active.session;
  }

  async start(
    request: BroadcastPublicationRequest,
    signal: AbortSignal,
  ): Promise<BroadcastPublicationSession> {
    signal.throwIfAborted();
    const key = this.programKey(request);
    const active = this.sessionsByProgram.get(key);
    if (active && active.lifecycle !== "stopped") return active.session;
    const pending = this.startTasks.get(key);
    if (pending) return pending;
    const task = this.create(request, signal);
    this.startTasks.set(key, task);
    try {
      return await task;
    } finally {
      if (this.startTasks.get(key) === task) this.startTasks.delete(key);
    }
  }

  async stop(session: BroadcastPublicationSession, signal: AbortSignal): Promise<void> {
    const active = this.sessions.get(session.sessionId);
    if (!active) return;
    if (active.stopTask) return active.stopTask;
    const task = this.delete(active, signal);
    active.stopTask = task;
    try {
      await task;
    } finally {
      if (active.stopTask === task) active.stopTask = null;
    }
  }

  async restartIce(session: BroadcastPublicationSession, signal: AbortSignal): Promise<void> {
    const active = this.sessions.get(session.sessionId);
    if (!active || active.lifecycle === "stopped") fail("unknown_whip_session");
    if (!active.etag) fail("whip_ice_restart_unsupported");
    if (active.restartAttempts >= Math.max(1, this.configuration.retryBudget + 1)) {
      active.lifecycle = "failed";
      active.errorCode = "whip_ice_restart_budget_exhausted";
      fail(active.errorCode);
    }
    active.restartAttempts += 1;
    active.lifecycle = "degraded";
    active.errorCode = "whip_ice_restarting";
    const collector = collectCandidates(active.peerConnection, this.configuration.maximumCandidates);
    try {
      active.peerConnection.restartIce();
      const offer = await active.peerConnection.createOffer({ iceRestart: true });
      const prepared = prepareWhipOffer(offer.sdp, this.configuration.maximumSdpBytes);
      await active.peerConnection.setLocalDescription({ type: "offer", sdp: prepared });
      await waitForState(
        active.peerConnection,
        "ice-gathering",
        this.configuration.iceGatheringTimeoutMs,
        signal,
      );
      if (collector.overflowed()) fail("whip_too_many_ice_candidates");
      const localSdp = active.peerConnection.localDescription?.sdp || prepared;
      const fragment = createWhipIceFragment(
        localSdp,
        collector.candidates,
        collector.ended(),
        this.configuration.maximumIceFragmentBytes,
      );
      const result = await this.authorizedFetch("whip:update", active.program, active.resourceUrl, {
        method: "PATCH",
        headers: {
          "content-type": ICE_CONTENT_TYPE,
          accept: ICE_CONTENT_TYPE,
          "if-match": "*",
        },
        body: fragment,
      }, signal);
      if (result.response.status !== 200) fail(statusError(result.response));
      const etag = result.response.headers.get("etag");
      if (!etag || !STRONG_ETAG.test(etag)) fail("invalid_whip_etag");
      const answerFragment = await readBoundedText(
        result.response,
        this.configuration.maximumIceFragmentBytes,
        ICE_CONTENT_TYPE,
      );
      const previousAnswer = active.peerConnection.remoteDescription?.sdp;
      const answer = applyWhipIceRestartAnswer(
        previousAnswer,
        answerFragment,
        this.configuration.maximumSdpBytes,
        this.configuration.maximumIceFragmentBytes,
      );
      await active.peerConnection.setRemoteDescription({ type: "answer", sdp: answer });
      active.etag = etag;
      await waitForState(active.peerConnection, "connection", this.configuration.connectionTimeoutMs, signal);
      active.lifecycle = "connected";
      active.errorCode = "";
    } catch (error) {
      active.lifecycle = "failed";
      active.errorCode = safeErrorCode(error, "whip_ice_restart_failed");
      throw error;
    } finally {
      collector.close();
    }
  }

  async sampleStats(session: BroadcastPublicationSession): Promise<WhipAdaptationSample> {
    const active = this.sessions.get(session.sessionId);
    if (!active || active.lifecycle === "stopped") fail("unknown_whip_session");
    const sample = await active.senderController.sample();
    active.adaptationReason = sample.reasonCode;
    return sample;
  }

  private async create(
    request: BroadcastPublicationRequest,
    signal: AbortSignal,
  ): Promise<BroadcastPublicationSession> {
    const media = this.resolveMedia(
      request.composition,
      await this.dependencies.media.resolve(request.composition, signal),
    );
    signal.throwIfAborted();
    const { stream } = media;
    const tracks = media.tracks.map(({ track }) => track);
    const audio = tracks.filter((track) => track.kind === "audio");
    const video = tracks.filter((track) => track.kind === "video");
    if (tracks.length < 1 || tracks.length > 2 || audio.length > 1 || video.length > 1
      || tracks.some((track) => track.readyState !== "live")) fail("invalid_whip_media_stream");
    const peerConnection = this.peerConnections.create({
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceServers: [...this.configuration.iceServers],
    });
    const collector = collectCandidates(peerConnection, this.configuration.maximumCandidates);
    const bindings: WhipSenderBinding[] = [];
    let resourceUrl: string | null = null;
    try {
      for (const track of [...audio, ...video]) {
        const descriptor = media.tracks.find((candidate) => candidate.track === track)!;
        bindings.push(Object.freeze({ descriptor, sender: this.addTrack(peerConnection, descriptor, stream) }));
      }
      const offer = await peerConnection.createOffer();
      const preparedOffer = prepareWhipOffer(offer.sdp, this.configuration.maximumSdpBytes);
      await peerConnection.setLocalDescription({ type: "offer", sdp: preparedOffer });
      if (!this.configuration.trickleIce) {
        await waitForState(peerConnection, "ice-gathering", this.configuration.iceGatheringTimeoutMs, signal);
      }
      const localOffer = prepareWhipOffer(
        peerConnection.localDescription?.sdp || preparedOffer,
        this.configuration.maximumSdpBytes,
      );
      const result = await this.createSession(request, localOffer, signal);
      const response = result.response;
      if (response.status !== 201) fail(statusError(response));
      const answer = validateWhipAnswer(
        await readBoundedText(response, this.configuration.maximumResponseBytes, SDP_CONTENT_TYPE),
        this.configuration.maximumSdpBytes,
        { allowMissingRtcpMuxOnly: this.configuration.compatibilityProfile === "mediamtx-1.20" },
      );
      const location = response.headers.get("location");
      if (!location) fail("whip_location_required");
      const responseUrl = response.url || result.requestUrl;
      resourceUrl = assertWhipResourceUrl(new URL(location, responseUrl).href, this.configuration).href;
      const etag = response.headers.get("etag");
      const compatibleWildcardEtag = this.configuration.compatibilityProfile === "mediamtx-1.20" && etag === "*";
      if (this.configuration.trickleIce && (!etag || (!STRONG_ETAG.test(etag) && !compatibleWildcardEtag))) {
        fail("invalid_whip_etag");
      }
      await peerConnection.setRemoteDescription({ type: "answer", sdp: answer });
      if (this.configuration.trickleIce) {
        await waitForState(peerConnection, "ice-gathering", this.configuration.iceGatheringTimeoutMs, signal);
        if (collector.overflowed()) fail("whip_too_many_ice_candidates");
        if (collector.candidates.length > 0 || collector.ended()) {
          const localSdp = peerConnection.localDescription?.sdp || localOffer;
          await this.patchCandidates(
            request,
            resourceUrl,
            String(etag),
            createWhipIceFragment(
              localSdp,
              collector.candidates,
              collector.ended(),
              this.configuration.maximumIceFragmentBytes,
            ),
            signal,
          );
        }
      }
      await waitForState(peerConnection, "connection", this.configuration.connectionTimeoutMs, signal);
      const session = Object.freeze({
        sessionId: randomSessionId(),
        adapterId: "whip-browser",
        programId: request.program.programId,
        programEpoch: request.program.programEpoch,
      });
      const senderController = new WhipAdaptiveSenderController(
        peerConnection,
        bindings,
        this.senderPolicy,
        this.now,
      );
      const senderParametersApplied = await senderController.apply();
      const active: ActiveWhipSession = {
        session,
        program: request.program,
        peerConnection,
        resourceUrl,
        request,
        media,
        bindings: Object.freeze(bindings),
        senderController,
        adaptationTimer: null,
        adaptationRunning: false,
        adaptationReason: senderParametersApplied ? "initial-profile" : "sender-parameters-unavailable",
        trackListeners: new Map(),
        etag: etag && STRONG_ETAG.test(etag) ? etag : null,
        lifecycle: senderParametersApplied ? "connected" : "degraded",
        errorCode: senderParametersApplied ? "" : "whip_sender_parameters_degraded",
        restartAttempts: 0,
        stopTask: null,
        connectionListener: () => undefined,
      };
      active.connectionListener = () => {
        if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "disconnected") {
          active.lifecycle = "degraded";
          active.errorCode = "whip_connection_lost";
        } else if (peerConnection.connectionState === "connected") {
          active.lifecycle = "connected";
          active.errorCode = "";
        }
      };
      peerConnection.addEventListener("connectionstatechange", active.connectionListener);
      this.installTrackListeners(active);
      if (this.dependencies.scheduleAdaptation !== false) {
        active.adaptationTimer = setInterval(() => void this.sampleAdaptation(active), senderController.intervalMs);
      }
      this.sessions.set(session.sessionId, active);
      this.sessionsByProgram.set(this.programKey(request), active);
      return session;
    } catch (error) {
      peerConnection.close();
      if (resourceUrl) await this.bestEffortDelete(request, resourceUrl);
      throw error;
    } finally {
      collector.close();
    }
  }

  private addTrack(
    peerConnection: RTCPeerConnection,
    descriptor: WhipMediaTrackDescriptor,
    stream: MediaStream,
  ): RTCRtpSender {
    const { track } = descriptor;
    const init: RTCRtpTransceiverInit = { direction: "sendonly", streams: [stream] };
    if (track.kind === "video" && descriptor.sourceKind === "camera" && this.configuration.simulcast.enabled) {
      init.sendEncodings = this.configuration.simulcast.sendEncodings.map((encoding) => ({ ...encoding }));
    }
    const transceiver = peerConnection.addTransceiver(track, init);
    const preferences = this.configuration.codecPreferences[track.kind as "audio" | "video"];
    if (preferences.length === 0) return transceiver.sender;
    const capabilities = this.peerConnections.capabilities(track.kind as "audio" | "video");
    if (!capabilities) fail("whip_codec_capability_unavailable");
    const preferred = preferences.flatMap((mimeType) => capabilities.codecs.filter(
      (codec) => codec.mimeType.toLowerCase() === mimeType,
    ));
    if (preferred.length === 0) fail("whip_codec_unsupported");
    const repair = capabilities.codecs.filter((codec) => new Set([
      "video/rtx", "video/red", "video/ulpfec", "audio/red",
    ]).has(codec.mimeType.toLowerCase()));
    transceiver.setCodecPreferences([...new Set([...preferred, ...repair])]);
    return transceiver.sender;
  }

  private async createSession(
    request: BroadcastPublicationRequest,
    offer: string,
    signal: AbortSignal,
  ): Promise<HttpResult> {
    let attempt = 0;
    while (true) {
      const result = await this.authorizedFetch("whip:create", request.program, this.configuration.endpointUrl, {
        method: "POST",
        headers: { "content-type": SDP_CONTENT_TYPE, accept: SDP_CONTENT_TYPE },
        body: offer,
      }, signal);
      if (result.response.status !== 429 && result.response.status !== 503) return result;
      if (attempt >= this.configuration.retryBudget) return result;
      attempt += 1;
      await this.delay(retryDelay(result.response), signal);
    }
  }

  private async patchCandidates(
    request: BroadcastPublicationRequest,
    resourceUrl: string,
    etag: string,
    fragment: string,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await this.authorizedFetch("whip:update", request.program, resourceUrl, {
      method: "PATCH",
      headers: {
        "content-type": ICE_CONTENT_TYPE,
        accept: ICE_CONTENT_TYPE,
        "if-match": etag,
      },
      body: fragment,
    }, signal);
    if (result.response.status !== 204) fail(statusError(result.response));
  }

  private async delete(active: ActiveWhipSession, signal: AbortSignal): Promise<void> {
    if (active.adaptationTimer !== null) {
      clearInterval(active.adaptationTimer);
      active.adaptationTimer = null;
    }
    this.removeTrackListeners(active);
    active.senderController.close();
    active.peerConnection.removeEventListener("connectionstatechange", active.connectionListener);
    active.peerConnection.close();
    active.lifecycle = "stopped";
    active.errorCode = "";
    let attempt = 0;
    while (true) {
      try {
        const result = await this.authorizedFetch("whip:delete", active.program, active.resourceUrl, {
          method: "DELETE",
          headers: { accept: "*/*" },
        }, signal);
        if ((result.response.status >= 200 && result.response.status < 300)
          || result.response.status === 404 || result.response.status === 410) break;
        if ((result.response.status === 429 || result.response.status === 503)
          && attempt < this.configuration.retryBudget) {
          attempt += 1;
          await this.delay(retryDelay(result.response), signal);
          continue;
        }
        fail(statusError(result.response));
      } catch (error) {
        if (isAbort(error) || attempt >= this.configuration.retryBudget) {
          active.lifecycle = "failed";
          active.errorCode = safeErrorCode(error, "whip_delete_failed");
          throw error;
        }
        attempt += 1;
        await this.delay(100, signal);
      }
    }
    this.sessions.delete(active.session.sessionId);
    const key = `${active.program.programId}:${active.program.programEpoch}`;
    if (this.sessionsByProgram.get(key) === active) this.sessionsByProgram.delete(key);
  }

  private async bestEffortDelete(request: BroadcastPublicationRequest, resourceUrl: string): Promise<void> {
    try {
      await this.authorizedFetch("whip:delete", request.program, resourceUrl, {
        method: "DELETE",
        headers: { accept: "*/*" },
      }, new AbortController().signal);
    } catch {
      // The original setup error remains authoritative; the gateway also owns an idle timeout.
    }
  }

  private async authorizedFetch(
    action: WhipAction,
    program: BroadcastPublicationRequest["program"],
    resourceUrl: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<HttpResult> {
    const target = assertWhipResourceUrl(resourceUrl, this.configuration);
    const authorization = normalizeWhipAuthorization(await this.dependencies.authorization.authorize({
      requestVersion: 1,
      program,
      action,
      resourceUrl: target.href,
    }, signal), this.now());
    signal.throwIfAborted();
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(new DOMException("Timeout", "AbortError")),
      this.configuration.requestTimeoutMs);
    const abort = () => timeoutController.abort(
      signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"),
    );
    signal.addEventListener("abort", abort, { once: true });
    try {
      let response: Response;
      try {
        response = await this.fetchRequest(target.href, {
          ...init,
          headers: {
            ...init.headers,
            authorization: `Bearer ${authorization.accessToken}`,
          },
          mode: "cors",
          credentials: "omit",
          cache: "no-store",
          redirect: "follow",
          referrerPolicy: "no-referrer",
          signal: timeoutController.signal,
        });
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        if (timeoutController.signal.aborted) fail("whip_request_timeout");
        throw new BroadcastBrowserPortError("whip_network_or_cors_error");
      }
      if (response.type === "opaque" || response.type === "opaqueredirect" || response.status === 0) {
        fail("whip_cors_response_blocked");
      }
      const finalUrl = response.url || target.href;
      assertWhipResourceUrl(finalUrl, this.configuration);
      return Object.freeze({ response, requestUrl: finalUrl });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }

  private resolveMedia(
    composition: BroadcastPublicationRequest["composition"],
    value: unknown,
  ): WhipResolvedMedia {
    const media = normalizeWhipResolvedMedia(value);
    if (composition.sourceIds.length !== media.tracks.length
      || !composition.sourceIds.every((sourceId) => media.tracks.some(
        (descriptor) => descriptor.sourceId === sourceId,
      ))) fail("whip_composition_source_mismatch");
    return media;
  }

  private installTrackListeners(active: ActiveWhipSession): void {
    const listeners = new Map<MediaStreamTrack, () => void>();
    for (const { descriptor } of active.bindings) {
      const listener = () => {
        if (active.lifecycle === "stopped" || active.lifecycle === "failed") return;
        active.lifecycle = "degraded";
        active.errorCode = `whip_${descriptor.track.kind}_source_ended`;
        active.adaptationReason = "source-ended";
      };
      descriptor.track.addEventListener("ended", listener, { once: true });
      listeners.set(descriptor.track, listener);
    }
    active.trackListeners = listeners;
  }

  private removeTrackListeners(active: ActiveWhipSession): void {
    for (const [track, listener] of active.trackListeners) track.removeEventListener("ended", listener);
    active.trackListeners = new Map();
  }

  private async sampleAdaptation(active: ActiveWhipSession): Promise<void> {
    if (active.adaptationRunning || active.lifecycle === "stopped" || active.lifecycle === "failed") return;
    active.adaptationRunning = true;
    try {
      await this.sampleStats(active.session);
    } catch {
      active.lifecycle = "degraded";
      active.errorCode = "whip_sender_adaptation_unavailable";
      active.adaptationReason = "stats-unavailable";
    } finally {
      active.adaptationRunning = false;
    }
  }

  private programKey(request: BroadcastPublicationRequest): string {
    return `${request.program.programId}:${request.program.programEpoch}`;
  }
}
