import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { chromium, firefox } from "playwright";
import ts from "typescript";

if (process.env.RUN_LIVE_MEDIA_AGENT_ROOM !== "1") {
  console.log("SKIP live media-agent room gate: set RUN_LIVE_MEDIA_AGENT_ROOM=1 with explicit test credentials and two agent IDs");
  process.exit(0);
}

const appOrigin = process.env.LIVE_APP_ORIGIN || "https://webrtc.ananta.de";
const username = process.env.LIVE_OIDC_USERNAME || "";
const password = process.env.LIVE_OIDC_PASSWORD || "";
const scenario = process.env.LIVE_MEDIA_AGENT_ICE_SCENARIO || "direct";
const faultMode = process.env.LIVE_MEDIA_AGENT_FAULT_MODE
  || (process.env.LIVE_MEDIA_AGENT_FAULTS === "1" ? "outage" : "none");
const runFaults = faultMode !== "none";
const forceSingleLayer = process.env.LIVE_MEDIA_AGENT_FORCE_SINGLE_LAYER === "1";
const routeTimeoutMs = Math.max(15_000, Math.min(120_000,
  Number(process.env.LIVE_MEDIA_AGENT_ROUTE_TIMEOUT_MS || "90000") || 90_000));
const agentIds = String(process.env.LIVE_MEDIA_AGENT_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const AGENT_ID_PATTERN = /^edge-[a-f0-9]{16}$/;
assert.ok(username && password, "LIVE_OIDC_USERNAME and LIVE_OIDC_PASSWORD are required");
assert.equal(new URL(appOrigin).protocol, "https:", "live room gate requires HTTPS");
assert.ok(scenario === "direct" || scenario === "all-turn", "ICE scenario must be direct or all-turn");
assert.ok(["none", "outage", "drain", "partition"].includes(faultMode),
  "fault mode must be none, outage, drain or partition");
assert.equal(agentIds.length, 2, "exactly two agent IDs are required");
assert.ok(agentIds.every((id) => AGENT_ID_PATTERN.test(id)), "invalid media-agent ID");
assert.equal(new Set(agentIds).size, agentIds.length, "media-agent IDs must be unique");

await Promise.all([fs.access(chromium.executablePath()), fs.access(firefox.executablePath())]);

const names = ["Gate-A", "Gate-B", "Gate-C", "Gate-D", "Gate-E", "Gate-F"];
const receiveProfiles = ["auto", "low", "medium", "high", "audio-only", "low"];
const forceRelay = scenario === "all-turn";
const relayBrowserIndexes = Object.freeze(forceRelay ? [0, names.length - 1] : []);
const glareDelayMs = Math.max(0, Math.min(2_000,
  Number(process.env.LIVE_MEDIA_AGENT_GLARE_DELAY_MS || "0") || 0));

async function instrument(context, forceRelayPolicy, delayedOfferMs, forceSingleLayerPolicy) {
  await context.addInitScript(({ forceRelayPolicy, delayedOfferMs, forceSingleLayerPolicy }) => {
    const summarizeSdp = (description, direction) => {
      const lines = description.sdp.split(/\r?\n/);
      const sections = [];
      let current = null;
      for (const line of lines) {
        if (line.startsWith("m=")) {
          if (current) sections.push(current);
          current = {
            kind: line.split(" ")[0].slice(2),
            direction: "sendrecv",
            rids: [],
            simulcast: [],
            hasMsid: false,
            ssrcCount: 0,
          };
          continue;
        }
        if (!current) continue;
        if (["a=sendrecv", "a=sendonly", "a=recvonly", "a=inactive"].includes(line)) {
          current.direction = line.slice(2);
        } else if (line.startsWith("a=rid:")) {
          const fields = line.slice(6).split(/\s+/);
          current.rids.push({ rid: fields[0] || "", direction: fields[1] || "" });
        } else if (line.startsWith("a=simulcast:")) {
          current.simulcast.push(line.slice(12).split(/\s+/).slice(0, 2).join(" "));
        } else if (line.startsWith("a=msid:")) {
          current.hasMsid = true;
        } else if (line.startsWith("a=ssrc:") && line.includes(" cname:")) {
          current.ssrcCount += 1;
        }
      }
      if (current) sections.push(current);
      return {
        eventDirection: direction,
        type: description.type,
        signalingSections: sections,
        hasMidExtension: lines.some((line) => line.includes("urn:ietf:params:rtp-hdrext:sdes:mid")),
        hasRidExtension: lines.some((line) => line.includes("urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id")),
      };
    };
    const gate = window.__mediaAgentRoomGate = {
      captureCalls: [],
      localTrackSources: {},
      peerConnections: [],
      routeStates: [],
      subscriptionIntents: [],
      serverTrackStates: [],
      serverSubscriptionStates: [],
      agentSignalSdp: [],
      agentCandidateTypes: { sent: [], received: [] },
      senderParameterEvents: [],
      sentControlTypes: [],
      receivedControlTypes: [],
      agentNegotiationSentTypes: [],
      agentNegotiationReceivedTypes: [],
      signalingCloseEvents: [],
      serverErrorCodes: [],
      receivedAgentDescriptions: [],
      sessionRequests: [],
      ownPeerId: "",
      topology: { membershipEpoch: 0, peerIds: [] },
      rawRouteState: null,
    };

    let forcedRelayIceServers = [];
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      let sessionRequest = false;
      try {
        const target = args[0] instanceof Request ? args[0].url : String(args[0]);
        const url = new URL(target, window.location.href);
        sessionRequest = url.origin === window.location.origin && url.pathname === "/api/sessions";
      } catch {}
      try {
        const response = await nativeFetch(...args);
        if (sessionRequest && gate.sessionRequests.length < 16) {
          gate.sessionRequests.push({ status: response.status });
        }
        if (sessionRequest && forceRelayPolicy && response.ok) {
          try {
            const body = await response.clone().json();
            forcedRelayIceServers = Array.isArray(body?.icePolicy?.infrastructureRelayIceServers)
              ? body.icePolicy.infrastructureRelayIceServers
              : [];
          } catch {
            forcedRelayIceServers = [];
          }
        }
        return response;
      } catch (error) {
        if (sessionRequest && gate.sessionRequests.length < 16) {
          gate.sessionRequests.push({ status: 0, failure: error instanceof Error ? error.name : "unknown" });
        }
        throw error;
      }
    };

    const devices = navigator.mediaDevices;
    if (devices) {
      for (const method of ["getUserMedia", "getDisplayMedia"]) {
        const original = devices[method]?.bind(devices);
        if (!original) continue;
        devices[method] = async (...args) => {
          gate.captureCalls.push(method);
          const stream = await original(...args);
          const constraints = args[0] || {};
          const source = method === "getDisplayMedia" ? "screen" : constraints.video ? "camera" : "microphone";
          for (const track of stream.getTracks()) gate.localTrackSources[track.id] = source;
          return stream;
        };
      }
    }

    const nativeSetParameters = RTCRtpSender.prototype.setParameters;
    RTCRtpSender.prototype.setParameters = function observedSetParameters(parameters) {
      const event = {
        trackId: this.track?.id || "",
        encodings: (parameters.encodings || []).map((encoding) => ({
          rid: encoding.rid || "",
          active: encoding.active,
          maxBitrate: encoding.maxBitrate,
          maxFramerate: encoding.maxFramerate,
          scaleResolutionDownBy: encoding.scaleResolutionDownBy,
        })),
        succeeded: null,
      };
      gate.senderParameterEvents.push(event);
      return nativeSetParameters.call(this, parameters).then((result) => {
        event.succeeded = true;
        return result;
      }, (error) => {
        event.succeeded = false;
        throw error;
      });
    };

    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(Target, args) {
        const configuration = { ...(args[0] || {}) };
        const connection = Reflect.construct(Target, [configuration, ...args.slice(1)]);
        const record = {
          connection,
          dataLabels: [],
          transceivers: [],
          addedTracks: [],
          inboundTracks: [],
          localCandidateTypes: [],
          forceRelay: false,
          signalingStates: [connection.signalingState],
          descriptionOperations: [],
        };
        gate.peerConnections.push(record);
        const observeDescription = async (operation, type, callback) => {
          const event = {
            operation,
            type,
            before: connection.signalingState,
            after: "pending",
            outcome: "pending",
          };
          if (record.descriptionOperations.length < 256) record.descriptionOperations.push(event);
          try {
            const result = await callback();
            event.after = connection.signalingState;
            event.outcome = "ok";
            return result;
          } catch (error) {
            event.after = connection.signalingState;
            event.outcome = error instanceof DOMException ? error.name : "Error";
            event.reason = String(error instanceof Error ? error.message : error)
              .replace(/[a-f0-9]{16}/gi, "<peer>")
              .replace(/room-[a-z0-9-]+/gi, "<room>")
              .replace(/[\r\n]+/g, " ")
              .slice(0, 320);
            throw error;
          }
        };
        const nativeSetLocalDescription = connection.setLocalDescription.bind(connection);
        connection.setLocalDescription = (description) => observeDescription(
          "local",
          description?.type || "auto",
          () => nativeSetLocalDescription(description),
        );
        const nativeSetRemoteDescription = connection.setRemoteDescription.bind(connection);
        connection.setRemoteDescription = (description) => observeDescription(
          "remote",
          description.type,
          () => nativeSetRemoteDescription(description),
        );
        const nativeSetConfiguration = connection.setConfiguration.bind(connection);
        connection.setConfiguration = (next) => nativeSetConfiguration(
          record.forceRelay ? { ...next, iceTransportPolicy: "relay" } : next,
        );
        const nativeCreateDataChannel = connection.createDataChannel.bind(connection);
        connection.createDataChannel = (label, ...rest) => {
          record.dataLabels.push(String(label));
          if (forceRelayPolicy && label === "media-agent-control") {
            record.forceRelay = true;
            const current = connection.getConfiguration();
            connection.setConfiguration({
              iceServers: [...(current.iceServers || []), ...forcedRelayIceServers],
              iceTransportPolicy: "relay",
            });
          }
          const channel = nativeCreateDataChannel(label, ...rest);
          if (label === "media-agent-control") {
            const nativeChannelSend = channel.send.bind(channel);
            channel.send = (data) => {
              try {
                const value = typeof data === "string" ? JSON.parse(data) : null;
                if (typeof value?.type === "string" && gate.agentNegotiationSentTypes.length < 256) {
                  gate.agentNegotiationSentTypes.push(value.type);
                }
              } catch {}
              return nativeChannelSend(data);
            };
            channel.addEventListener("message", (event) => {
              try {
                const value = typeof event.data === "string" ? JSON.parse(event.data) : null;
                if (typeof value?.type === "string" && gate.agentNegotiationReceivedTypes.length < 256) {
                  gate.agentNegotiationReceivedTypes.push(value.type);
                }
              } catch {}
            });
          }
          return channel;
        };
        const nativeAddTrack = connection.addTrack.bind(connection);
        connection.addTrack = (track, ...streams) => {
          record.addedTracks.push({ trackId: track.id, kind: track.kind });
          return nativeAddTrack(track, ...streams);
        };
        const nativeAddTransceiver = connection.addTransceiver.bind(connection);
        connection.addTransceiver = (trackOrKind, init = {}) => {
          const track = typeof trackOrKind === "string" ? null : trackOrKind;
          const sendEncodings = (init.sendEncodings || []).map((encoding) => ({
            rid: encoding.rid || "",
            active: encoding.active,
            maxBitrate: encoding.maxBitrate,
            maxFramerate: encoding.maxFramerate,
            scaleResolutionDownBy: encoding.scaleResolutionDownBy,
          }));
          const forcedFailure = forceSingleLayerPolicy
            && record.dataLabels.includes("media-agent-control")
            && track?.kind === "video"
            && ["q", "h", "f"].every((rid) => sendEncodings.some((encoding) => encoding.rid === rid));
          record.transceivers.push({
            trackId: track?.id || "",
            kind: track?.kind || String(trackOrKind),
            sendEncodings,
            forcedFailure,
          });
          if (forcedFailure) throw new DOMException("forced single-layer gate", "NotSupportedError");
          return nativeAddTransceiver(trackOrKind, init);
        };
        connection.addEventListener("icecandidate", (event) => {
          if (!event.candidate) return;
          const match = /(?:^| )typ ([a-z]+)/.exec(event.candidate.candidate);
          if (match && !record.localCandidateTypes.includes(match[1])) record.localCandidateTypes.push(match[1]);
        });
        connection.addEventListener("track", (event) => {
          record.inboundTracks.push({ kind: event.track.kind, streamCount: event.streams.length });
        });
        connection.addEventListener("signalingstatechange", () => {
          if (record.signalingStates.length < 256) record.signalingStates.push(connection.signalingState);
        });
        return connection;
      },
    });

    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args) {
        const socket = Reflect.construct(Target, args);
        const nativeSend = socket.send.bind(socket);
        let agentOfferCount = 0;
        socket.send = (data) => {
          let delaySend = false;
          try {
            const value = typeof data === "string" ? JSON.parse(data) : null;
            if (typeof value?.type === "string" && gate.sentControlTypes.length < 4096) {
              gate.sentControlTypes.push(value.type);
            }
            if (value?.type === "media-agent-subscription-intent") {
              gate.subscriptionIntents.push({
                publisherPeerId: value.publisherPeerId,
                publicationId: value.publicationId,
                enabled: value.enabled,
                preferredLayer: value.preferredLayer,
                maximumLayer: value.maximumLayer,
              });
            }
            if (value?.type === "media-agent-signal" && typeof value.description?.sdp === "string") {
              gate.agentSignalSdp.push(summarizeSdp(value.description, "sent"));
              if (value.description.type === "offer") {
                agentOfferCount += 1;
                delaySend = delayedOfferMs > 0 && agentOfferCount > 1;
              }
            }
            if (value?.type === "media-agent-signal" && typeof value.candidate?.candidate === "string") {
              const match = value.candidate.candidate.match(/\btyp\s+([a-z]+)/i);
              if (match && gate.agentCandidateTypes.sent.length < 256) {
                gate.agentCandidateTypes.sent.push({
                  type: match[1].toLowerCase(),
                  generationBound: typeof value.candidate.usernameFragment === "string",
                });
              }
            }
          } catch {}
          if (delaySend) {
            setTimeout(() => nativeSend(data), delayedOfferMs);
            return;
          }
          return nativeSend(data);
        };
        socket.addEventListener("message", (event) => {
          try {
            const value = typeof event.data === "string" ? JSON.parse(event.data) : null;
            if (typeof value?.type === "string" && gate.receivedControlTypes.length < 4096) {
              gate.receivedControlTypes.push(value.type);
            }
            if (value?.type === "error" && typeof value.code === "string" && gate.serverErrorCodes.length < 256) {
              gate.serverErrorCodes.push(value.code);
            }
            if (value?.type === "media-agent-signal" && typeof value.description?.sdp === "string"
              && gate.receivedAgentDescriptions.length < 256) {
              gate.receivedAgentDescriptions.push(summarizeSdp(value.description, "received"));
            }
            if (value?.type === "media-agent-signal" && typeof value.candidate?.candidate === "string") {
              const match = value.candidate.candidate.match(/\btyp\s+([a-z]+)/i);
              if (match && gate.agentCandidateTypes.received.length < 256) {
                gate.agentCandidateTypes.received.push({
                  type: match[1].toLowerCase(),
                  generationBound: typeof value.candidate.usernameFragment === "string",
                });
              }
            }
            if (value?.type === "welcome") gate.ownPeerId = value.peerId;
            if (value?.type === "topology-state") {
              gate.topology = { membershipEpoch: value.membershipEpoch, peerIds: [...(value.peers || [])] };
            }
            if (value?.type === "media-agent-track-state") {
              if (gate.serverTrackStates.length < 4096) {
                gate.serverTrackStates.push({
                  peerId: value.peerId,
                  publicationId: value.publicationId,
                  source: value.source,
                  layer: value.layer,
                  rid: value.rid,
                  active: value.active,
                });
              }
            }
            if (value?.type === "media-agent-subscription-state") {
              if (gate.serverSubscriptionStates.length < 4096) {
                gate.serverSubscriptionStates.push({
                  publicationId: value.publicationId,
                  subscriberPeerId: value.subscriberPeerId,
                  selectedLayer: value.selectedLayer,
                  revision: value.revision,
                  ready: value.ready,
                });
              }
            }
            if (value?.type !== "media-agent-state") return;
            gate.rawRouteState = value;
            const memberIds = new Set(gate.topology.peerIds);
            const ownPublisher = value.publisherAssignments?.find((entry) => entry.peerId === gate.ownPeerId);
            const ownSubscriber = value.subscriberAssignments?.find((entry) => entry.peerId === gate.ownPeerId);
            if (gate.routeStates.length >= 1024) gate.routeStates.shift();
            gate.routeStates.push({
              version: value.version,
              enabled: value.enabled,
              fieldCount: Object.keys(value).length,
              membershipEpoch: value.membershipEpoch,
              topologyMembershipEpoch: gate.topology.membershipEpoch,
              topologyPeerCount: memberIds.size,
              leaseRemainingMs: value.leaseExpiresAt - Date.now(),
              routeEpoch: value.routeEpoch,
              primaryId: value.primary?.id || "",
              ownerIdsInMembership: [value.primary, ...(value.standbys || [])]
                .filter(Boolean).every((agent) => memberIds.has(agent.ownerPeerId)),
              standbyCount: value.standbys?.length || 0,
              forwarderIds: [...(value.forwarderIds || [])],
              ownPublisherAgentId: ownPublisher?.agentId || "",
              ownSubscriberAgentId: ownSubscriber?.agentId || "",
              publisherAgentIds: [...new Set((value.publisherAssignments || []).map((entry) => entry.agentId))],
              publisherAssignmentCount: value.publisherAssignments?.length || 0,
              publisherAssignmentsInMembership: (value.publisherAssignments || [])
                .every((entry) => memberIds.has(entry.peerId)),
              subscriberAssignmentCount: value.subscriberAssignments?.length || 0,
              subscriberAssignmentsInMembership: (value.subscriberAssignments || [])
                .every((entry) => memberIds.has(entry.peerId)),
              federationLinks: (value.federationLinks || []).map((link) => ({
                agents: [link.leftAgentId, link.rightAgentId].sort(),
                readyCount: link.readyAgentIds?.length || 0,
              })),
              federationRouteEdgeCounts: (value.federationRoutes || []).map((route) => route.edges?.length || 0),
              federationMaximumHops: (value.federationRoutes || []).map((route) => route.maximumHops),
              federationPublishersInMembership: (value.federationRoutes || [])
                .every((route) => memberIds.has(route.publisherPeerId)),
              readinessCounts: (value.readiness || []).map((entry) => ({
                agentId: entry.agentId,
                readyCount: entry.readyPeerIds?.length || 0,
              })),
            });
          } catch {}
        });
        socket.addEventListener("close", (event) => {
          if (gate.signalingCloseEvents.length < 16) {
            gate.signalingCloseEvents.push({ code: event.code, clean: event.wasClean });
          }
        });
        return socket;
      },
    });
  }, { forceRelayPolicy, delayedOfferMs, forceSingleLayerPolicy });
}

async function seedAuthenticatedSession(context, entries) {
  await context.addInitScript(({ origin, values }) => {
    if (location.origin !== origin) return;
    for (const [key, value] of values) sessionStorage.setItem(key, value);
  }, { origin: new URL(appOrigin).origin, values: entries });
}

async function login(page) {
  let lastFailure = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(appOrigin, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForFunction(() => document.querySelector("#login") || document.querySelector("#logout"));
      if (!(await page.locator("#logout").isVisible())) {
        await page.locator("#login").click();
        await page.waitForFunction(() => document.querySelector("#username") || document.querySelector("#logout"), null, {
          timeout: 30_000,
        });
        if (await page.locator("#username").isVisible()) {
          await page.locator("#username").fill(username);
          await page.locator("#password").fill(password);
          await page.locator("#kc-login").click();
        }
        await page.locator("#logout").waitFor({ timeout: 30_000 });
      }
      return;
    } catch (error) {
      lastFailure = await page.evaluate(() => ({
        location: `${location.origin}${location.pathname}`,
        visibleError: [...document.querySelectorAll("#input-error, .alert-error, .pf-v5-c-alert__title")]
          .map((entry) => entry.textContent?.trim().replace(/\s+/g, " ").slice(0, 160) || "")
          .filter(Boolean)
          .slice(0, 2),
      })).catch(() => ({ location: "unavailable", visibleError: [] }));
      lastFailure.error = error instanceof Error ? error.name : "Error";
      await page.waitForTimeout(500 * attempt);
    }
  }
  throw new Error(`OIDC browser login failed after bounded retries: ${JSON.stringify(lastFailure)}`);
}

async function waitForRoute(page, expectedForwarders) {
  try {
    await page.waitForFunction((expected) => {
      const states = window.__mediaAgentRoomGate?.routeStates || [];
      const state = states.at(-1);
      return state?.enabled === true
        && expected.every((id) => state.forwarderIds.includes(id))
        && state.federationLinks.some((link) => link.readyCount === 2)
        && state.readinessCounts.every((entry) => entry.readyCount >= 1);
    }, expectedForwarders, { timeout: routeTimeoutMs });
  } catch {
    const state = await latestRoute(page);
    const connections = safeMediaSnapshot(await mediaSnapshot(page));
    const captured = await page.evaluate(() => ({
      raw: window.__mediaAgentRoomGate.rawRouteState,
      members: window.__mediaAgentRoomGate.topology.peerIds,
      membershipEpoch: window.__mediaAgentRoomGate.topology.membershipEpoch,
      routeEpochs: window.__mediaAgentRoomGate.routeStates.map((entry) => entry.routeEpoch),
    }));
    const contractSource = await fs.readFile(new URL(
      "../frontend/src/app/webrtc/media-agent-contract.ts", import.meta.url,
    ), "utf8");
    const compiled = ts.transpileModule(contractSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText;
    const contract = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
    const highestPreviousEpoch = Math.max(0, ...captured.routeEpochs.slice(0, -1));
    const validation = {
      fromZero: Boolean(contract.validateMediaAgentRouteState(
        captured.raw, new Set(captured.members), captured.membershipEpoch, 0,
      )),
      fromPrevious: Boolean(contract.validateMediaAgentRouteState(
        captured.raw, new Set(captured.members), captured.membershipEpoch, highestPreviousEpoch,
      )),
      highestPreviousEpoch,
    };
    throw new Error(`media-agent route did not become ready: ${JSON.stringify({ state, connections, validation })}`);
  }
}

async function latestRoute(page) {
  return page.evaluate(() => window.__mediaAgentRoomGate.routeStates.at(-1));
}

async function mediaSnapshot(page) {
  return page.evaluate(async () => {
    const boundedStats = (endpoint) => Promise.race([
      endpoint.getStats(),
      new Promise((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    const records = window.__mediaAgentRoomGate.peerConnections;
    const summaries = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const report = await boundedStats(record.connection);
      const stats = new Map();
      report?.forEach((value, key) => stats.set(key, value));
      let selectedPair = null;
      let outboundVideoBytes = 0;
      let outboundAudioBytes = 0;
      let inboundVideoBytes = 0;
      let inboundAudioBytes = 0;
      const outboundByTrack = {};
      report?.forEach((value) => {
        if (value.type === "candidate-pair" && value.state === "succeeded" && (value.selected || value.nominated)) {
          const local = stats.get(value.localCandidateId);
          const remote = stats.get(value.remoteCandidateId);
          selectedPair = { localType: local?.candidateType || "", remoteType: remote?.candidateType || "" };
        }
        const kind = value.kind || value.mediaType;
        if (value.type === "outbound-rtp" && kind === "video") outboundVideoBytes += value.bytesSent || 0;
        if (value.type === "outbound-rtp" && kind === "audio") outboundAudioBytes += value.bytesSent || 0;
        if (value.type === "inbound-rtp" && kind === "video") inboundVideoBytes += value.bytesReceived || 0;
        if (value.type === "inbound-rtp" && kind === "audio") inboundAudioBytes += value.bytesReceived || 0;
      });
      if (!selectedPair) {
        for (const value of stats.values()) {
          if (value.type !== "transport" || !value.selectedCandidatePairId) continue;
          const pair = stats.get(value.selectedCandidatePairId);
          const local = stats.get(pair?.localCandidateId);
          const remote = stats.get(pair?.remoteCandidateId);
          if (pair?.type === "candidate-pair" && pair.state === "succeeded") {
            selectedPair = { localType: local?.candidateType || "", remoteType: remote?.candidateType || "" };
            break;
          }
        }
      }
      for (const sender of record.connection.getSenders()) {
        if (!sender.track) continue;
        const senderReport = await boundedStats(sender);
        let bytes = 0;
        senderReport?.forEach((value) => {
          if (value.type === "outbound-rtp") bytes += value.bytesSent || 0;
        });
        outboundByTrack[sender.track.id] = bytes;
      }
      summaries.push({
        index,
        agent: record.dataLabels.includes("media-agent-control"),
        connectionState: record.connection.connectionState,
        iceConnectionState: record.connection.iceConnectionState,
        policy: record.connection.getConfiguration().iceTransportPolicy || "all",
        statsTimedOut: report === null,
        localCandidateTypes: [...record.localCandidateTypes],
        selectedPair,
        outboundVideoBytes,
        outboundAudioBytes,
        inboundVideoBytes,
        inboundAudioBytes,
        outboundByTrack,
        inboundTracks: [...record.inboundTracks],
        signalingStates: [...record.signalingStates],
        descriptionOperations: [...record.descriptionOperations],
        transceiverStates: record.connection.getTransceivers().map((transceiver) => {
          const source = transceiver.sender.track
            ? window.__mediaAgentRoomGate.localTrackSources[transceiver.sender.track.id] || "remote"
            : "none";
          let encodings = [];
          try {
            encodings = transceiver.sender.getParameters().encodings?.map((encoding) => ({
              rid: encoding.rid || "",
              active: encoding.active !== false,
            })) || [];
          } catch {}
          return {
            midAssigned: Boolean(transceiver.mid),
            direction: transceiver.direction,
            currentDirection: transceiver.currentDirection || "none",
            stopped: transceiver.stopped,
            source,
            senderTrackLive: transceiver.sender.track?.readyState === "live",
            encodings,
          };
        }),
      });
    }
    return summaries;
  });
}

function safeMediaSnapshot(snapshots) {
  const withoutTrackIds = (snapshot) => {
    const safe = { ...snapshot };
    delete safe.outboundByTrack;
    return safe;
  };
  const direct = snapshots.filter((snapshot) => !snapshot.agent);
  return {
    agentConnections: snapshots.filter((snapshot) => snapshot.agent).map(withoutTrackIds),
    directConnections: {
      count: direct.length,
      connected: direct.filter((snapshot) => snapshot.connectionState === "connected").length,
      states: [...new Set(direct.map((snapshot) => snapshot.connectionState))],
      selectedPairTypes: [...new Set(direct.map((snapshot) => (
        snapshot.selectedPair ? `${snapshot.selectedPair.localType}-${snapshot.selectedPair.remoteType}` : "none"
      )))],
      outboundVideoBytes: direct.reduce((sum, snapshot) => sum + snapshot.outboundVideoBytes, 0),
      inboundVideoBytes: direct.reduce((sum, snapshot) => sum + snapshot.inboundVideoBytes, 0),
    },
  };
}

async function mediaDiagnostics() {
  return Promise.all(pages.map(async (page, index) => ({
    browser: index === pages.length - 1 ? "firefox" : "chromium",
    status: await page.locator("#media-agent-status").textContent().catch(() => "missing"),
    sframeStatus: await page.locator("#sframe-status").textContent().catch(() => "missing"),
    route: await latestRoute(page),
    connections: safeMediaSnapshot(await mediaSnapshot(page)),
    gate: await page.evaluate(() => {
      const gate = window.__mediaAgentRoomGate;
      const sourceByPublication = new Map(gate.serverTrackStates.map((state) => (
        [state.publicationId, state.source]
      )));
      return {
        captureCalls: [...gate.captureCalls],
        serverTrackStates: gate.serverTrackStates.slice(-64).map((state) => ({
          publisherIndex: gate.topology.peerIds.indexOf(state.peerId),
          source: state.source,
          layer: state.layer,
          rid: state.rid,
          active: state.active,
        })),
        serverSubscriptionStates: gate.serverSubscriptionStates.slice(-64).map((state) => ({
          source: sourceByPublication.get(state.publicationId)
            || gate.localTrackSources[state.publicationId] || "remote",
          subscriberIndex: gate.topology.peerIds.indexOf(state.subscriberPeerId),
          selectedLayer: state.selectedLayer,
          revision: state.revision,
          ready: state.ready,
        })),
        agentNegotiationSentTypes: [...gate.agentNegotiationSentTypes],
        agentNegotiationReceivedTypes: [...gate.agentNegotiationReceivedTypes],
        subscriptionIntents: gate.subscriptionIntents.slice(-64).map((intent) => ({
          publisherIndex: gate.topology.peerIds.indexOf(intent.publisherPeerId),
          source: sourceByPublication.get(intent.publicationId)
            || gate.localTrackSources[intent.publicationId] || "remote",
          enabled: intent.enabled,
          preferredLayer: intent.preferredLayer,
          maximumLayer: intent.maximumLayer,
        })),
        agentSignalSdp: gate.agentSignalSdp.slice(-64),
        agentCandidateTypes: {
          sent: gate.agentCandidateTypes.sent.slice(-64),
          received: gate.agentCandidateTypes.received.slice(-64),
        },
        receivedAgentDescriptions: gate.receivedAgentDescriptions.slice(-64),
        remoteMedia: [...document.querySelectorAll("article.remote-media")].map((article) => ({
          source: ["camera", "microphone", "screen"].includes(article.dataset.source)
            ? article.dataset.source : "unknown",
          transport: article.dataset.transportPeerId?.startsWith("agent:") ? "agent" : "direct",
          kind: article.querySelector("video, audio")?.tagName.toLowerCase() || "unknown",
        })),
      };
    }),
  })));
}

function byteDeltas(before, after, field) {
  const earlier = new Map(before.map((entry) => [entry.index, entry[field]]));
  return after.map((entry) => ({ ...entry, delta: entry[field] - (earlier.get(entry.index) || 0) }));
}

async function decodedFrames(page, publicationId, transport) {
  return page.evaluate(async ({ expectedPublicationId, expectedTransport }) => {
    const boundedStats = (endpoint) => Promise.race([
      endpoint.getStats(),
      new Promise((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    let frames = 0;
    let matched = false;
    const acceptedTrackIds = new Set([expectedPublicationId]);
    for (const article of document.querySelectorAll("article.remote-media")) {
      const agentTransport = article.dataset.transportPeerId?.startsWith("agent:") === true;
      if (article.dataset.publicationId !== expectedPublicationId
        || (expectedTransport === "agent") !== agentTransport) continue;
      const media = article.querySelector("video, audio");
      const stream = media?.srcObject;
      if (stream instanceof MediaStream) {
        for (const track of stream.getTracks()) acceptedTrackIds.add(track.id);
      }
    }
    for (const record of window.__mediaAgentRoomGate.peerConnections) {
      const agent = record.dataLabels.includes("media-agent-control");
      if ((expectedTransport === "agent") !== agent) continue;
      for (const receiver of record.connection.getReceivers()) {
        if (!acceptedTrackIds.has(receiver.track?.id || "") || receiver.track?.kind !== "video") continue;
        matched = true;
        const report = await boundedStats(receiver);
        report?.forEach((value) => {
          if (value.type === "inbound-rtp" && (value.kind || value.mediaType) === "video") {
            frames += value.framesDecoded || 0;
          }
        });
      }
    }
    return { matched, frames };
  }, { expectedPublicationId: publicationId, expectedTransport: transport });
}

async function waitForDecodedFrameDelta(page, publicationId, transport, baseline, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await decodedFrames(page, publicationId, transport);
    if (snapshot.frames > baseline) return snapshot.frames;
    await page.waitForTimeout(250);
  }
  throw new Error(`decoded frame delta timed out for ${transport}`);
}

async function publicationStats(page, publicationId, transport, direction) {
  return page.evaluate(async ({ expectedPublicationId, expectedTransport, expectedDirection }) => {
    const boundedStats = (endpoint) => Promise.race([
      endpoint.getStats(),
      new Promise((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    const totals = {
      matched: 0,
      bytes: 0,
      packets: 0,
      frames: 0,
      keyFrames: 0,
      framesDropped: 0,
      freezeCount: 0,
      pliCount: 0,
      nackCount: 0,
      connectionStates: [],
    };
    const acceptedTrackIds = new Set([expectedPublicationId]);
    if (expectedDirection === "inbound") {
      for (const article of document.querySelectorAll("article.remote-media")) {
        const agentTransport = article.dataset.transportPeerId?.startsWith("agent:") === true;
        if (article.dataset.publicationId !== expectedPublicationId
          || (expectedTransport === "agent") !== agentTransport) continue;
        const media = article.querySelector("video, audio");
        const stream = media?.srcObject;
        if (stream instanceof MediaStream) {
          for (const track of stream.getTracks()) acceptedTrackIds.add(track.id);
        }
      }
    }
    for (const record of window.__mediaAgentRoomGate.peerConnections) {
      const agent = record.dataLabels.includes("media-agent-control");
      if ((expectedTransport === "agent") !== agent) continue;
      const endpoints = expectedDirection === "outbound"
        ? record.connection.getSenders() : record.connection.getReceivers();
      for (const endpoint of endpoints) {
        if (!acceptedTrackIds.has(endpoint.track?.id || "") || endpoint.track?.kind !== "video") continue;
        totals.matched += 1;
        if (!totals.connectionStates.includes(record.connection.connectionState)) {
          totals.connectionStates.push(record.connection.connectionState);
        }
        const report = await boundedStats(endpoint);
        for (const value of report?.values() || []) {
          const expectedType = expectedDirection === "outbound" ? "outbound-rtp" : "inbound-rtp";
          if (value.type !== expectedType || (value.kind || value.mediaType) !== "video") continue;
          totals.bytes += expectedDirection === "outbound" ? value.bytesSent || 0 : value.bytesReceived || 0;
          totals.packets += expectedDirection === "outbound" ? value.packetsSent || 0 : value.packetsReceived || 0;
          totals.frames += expectedDirection === "outbound" ? value.framesEncoded || 0 : value.framesDecoded || 0;
          totals.keyFrames += expectedDirection === "outbound" ? value.keyFramesEncoded || 0 : value.keyFramesDecoded || 0;
          totals.framesDropped += value.framesDropped || 0;
          totals.freezeCount += value.freezeCount || 0;
          totals.pliCount += value.pliCount || 0;
          totals.nackCount += value.nackCount || 0;
        }
      }
    }
    return totals;
  }, {
    expectedPublicationId: publicationId,
    expectedTransport: transport,
    expectedDirection: direction,
  });
}

async function checkpoint(label, value) {
  console.log(`CHECKPOINT ${label} ${value}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`checkpoint ${label} timed out`)), 600_000);
    process.stdin.once("data", () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve();
    });
    process.stdin.resume();
  });
}

const chromiumBrowser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
  ],
});
const firefoxBrowser = await firefox.launch({
  headless: true,
  firefoxUserPrefs: {
    "media.navigator.streams.fake": true,
    "media.navigator.permission.disabled": true,
    "media.volume_scale": "0.0",
  },
});
const contexts = [];
const pages = [];
const pageErrors = [];

try {
  let authenticatedSession = [];
  for (let index = 0; index < names.length; index += 1) {
    const browser = index === names.length - 1 ? firefoxBrowser : chromiumBrowser;
    const context = await browser.newContext(index === names.length - 1 ? {} : {
      permissions: ["camera", "microphone"],
    });
    contexts.push(context);
    if (index > 0) await seedAuthenticatedSession(context, authenticatedSession);
    await instrument(
      context,
      relayBrowserIndexes.includes(index),
      index === 0 ? glareDelayMs : 0,
      forceSingleLayer && index === 0,
    );
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push({ browser: index + 1, type: error.name || "Error" }));
    pages.push(page);
    await login(page);
    if (index === 0) {
      authenticatedSession = await page.evaluate(() => [
        "webrtc.oidc.access-token", "webrtc.oidc.id-token", "webrtc.oidc.refresh-token",
      ].map((key) => [key, sessionStorage.getItem(key)]).filter(([, value]) => Boolean(value)));
      assert.ok(authenticatedSession.length >= 2, "OIDC session did not contain verified tokens");
    }
    console.log(`live gate authenticated browser ${index + 1}/${names.length}`);
  }

  for (const page of pages) {
    assert.deepEqual(await page.evaluate(() => window.__mediaAgentRoomGate.captureCalls), []);
  }

  const creator = pages[0];
  await creator.locator("#new-room-title").fill(`Live media-agent gate ${Date.now()}`);
  await creator.locator("#display-name").fill(names[0]);
  await creator.locator("#create-room").click();
  await creator.waitForFunction(() => document.querySelector("#room-id")?.value.startsWith("room-"));
  const roomId = await creator.locator("#room-id").inputValue();
  await creator.locator("#join-room").click();
  await creator.locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor({ timeout: 60_000 });

  for (let index = 1; index < pages.length; index += 1) {
    if (forceRelay) await pages[index].waitForTimeout(1_100);
    await pages[index].locator("#display-name").fill(names[index]);
    await pages[index].locator("#room-id").fill(roomId);
    await pages[index].locator("#join-room").click();
    try {
      await pages[index].locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor({ timeout: 60_000 });
    } catch {
      const diagnostics = await pages[index].evaluate(() => ({
        connectionStatus: document.querySelector("#connection-status")?.textContent?.trim().slice(0, 160) || "missing",
        sessionRequests: window.__mediaAgentRoomGate.sessionRequests.slice(-3),
        receivedControlTypes: [...window.__mediaAgentRoomGate.receivedControlTypes],
        serverErrorCodes: [...window.__mediaAgentRoomGate.serverErrorCodes],
        signalingCloseEvents: [...window.__mediaAgentRoomGate.signalingCloseEvents],
      }));
      throw new Error(`browser ${index + 1} did not join: ${JSON.stringify(diagnostics)}`);
    }
    console.log(`live gate joined browser ${index + 1}/${names.length}`);
  }
  await Promise.all(pages.map((page) => page.locator("#participant-count", { hasText: "6 / 20" }).waitFor({ timeout: 90_000 })));
  for (const page of pages) {
    assert.deepEqual(await page.evaluate(() => window.__mediaAgentRoomGate.captureCalls), []);
  }

  await creator.locator("#mesh-analysis-navigation").click();
  await creator.locator("#media-agent-analysis-panel").waitFor();
  const choices = creator.locator("label.agent-choice");
  for (let index = 0; index < await choices.count(); index += 1) {
    const choice = choices.nth(index);
    const text = await choice.textContent();
    const input = choice.locator("input[type=checkbox]");
    const shouldSelect = agentIds.some((id) => text?.includes(id));
    if (shouldSelect && !(await input.isChecked())) await input.check();
    if (!shouldSelect && await input.isChecked()) await input.uncheck();
  }
  for (const id of agentIds) {
    assert.equal(await choices.filter({ hasText: id }).count(), 1, `agent ${id} is not selectable`);
  }
  await creator.locator("#media-agent-consent").check();
  await creator.locator("#media-agent-auto-takeover").check();
  await waitForRoute(creator, agentIds);
  try {
    await Promise.all(pages.map((page) => (
      page.locator("#media-agent-status", { hasText: "connected" }).waitFor({ timeout: 90_000 })
    )));
  } catch {
    throw new Error(`not every browser connected to its assigned media agent: ${JSON.stringify(await mediaDiagnostics())}`);
  }

  const stableRoute = await latestRoute(creator);
  assert.deepEqual([...stableRoute.forwarderIds].sort(), [...agentIds].sort());
  assert.deepEqual([...stableRoute.publisherAgentIds].sort(), [...agentIds].sort());
  assert.equal(stableRoute.federationLinks.length, 1);
  assert.deepEqual(stableRoute.federationLinks[0].agents, [...agentIds].sort());

  for (let index = 0; index < pages.length; index += 1) {
    await pages[index].locator(".nav-item", { hasText: "Live" }).click();
    await pages[index].locator("#receive-quality-profile-live").selectOption(receiveProfiles[index]);
  }

  const pageRoutes = await Promise.all(pages.map(latestRoute));
  const creatorAgent = pageRoutes[0].ownPublisherAgentId;
  const secondAgent = agentIds.find((id) => id !== creatorAgent);
  let secondPublisherIndex = pageRoutes.findIndex((route, index) => index > 0
    && index < pages.length - 1 && route.ownPublisherAgentId === secondAgent);
  if (secondPublisherIndex < 0) secondPublisherIndex = pageRoutes.findIndex((route, index) => (
    index > 0 && route.ownPublisherAgentId === secondAgent
  ));
  assert.ok(secondPublisherIndex > 0, "no publisher was assigned to the second agent");

  await creator.locator("#toggle-camera").click();
  await creator.locator("#toggle-camera", { hasText: "Kamera stoppen" }).waitFor();
  const creatorCameraId = await creator.evaluate(() => Object.entries(
    window.__mediaAgentRoomGate.localTrackSources,
  ).find(([, source]) => source === "camera")?.[0] || "");
  assert.ok(creatorCameraId, "creator camera publication ID was not observed");
  await Promise.all([
    (async () => {
      await pages[secondPublisherIndex].locator("#toggle-camera").click();
      await pages[secondPublisherIndex].locator("#toggle-camera", { hasText: "Kamera stoppen" }).waitFor();
    })(),
    (async () => {
      await creator.locator("#toggle-microphone").click();
      await creator.locator("#toggle-microphone", { hasText: "Mikrofon stoppen" }).waitFor();
    })(),
  ]);
  await creator.locator("#toggle-screen").click();
  await creator.locator("#toggle-screen", { hasText: "Bildschirmfreigabe stoppen" }).waitFor({ timeout: 60_000 });
  const creatorPublications = await creator.evaluate(() => Object.fromEntries(
    Object.entries(window.__mediaAgentRoomGate.localTrackSources).map(([publicationId, source]) => [source, publicationId]),
  ));
  assert.ok(creatorPublications.camera && creatorPublications.microphone && creatorPublications.screen,
    "creator publication IDs were not observed");

  await creator.locator("#mesh-analysis-navigation").click();
  try {
    await creator.locator("#media-agent-simulcast", {
      hasText: forceSingleLayer ? "fallback" : "available",
    }).waitFor({ timeout: 60_000 });
  } catch {
    throw new Error(`camera layer mode was not activated: ${JSON.stringify(await mediaDiagnostics())}`);
  }
  await creator.waitForFunction(({ singleLayer, publicationId }) => {
    const gate = window.__mediaAgentRoomGate;
    const expectedRids = singleLayer ? ["s"] : ["q", "h", "f"];
    const senderReady = gate.peerConnections.some((record) => record.transceivers.some((entry) => (
      entry.trackId === publicationId
      && entry.forcedFailure !== true
      && expectedRids.every((rid) => entry.sendEncodings.some((encoding) => encoding.rid === rid))
    )));
    if (!senderReady) return false;
    return !singleLayer || gate.serverTrackStates.some((state) => (
      state.publicationId === publicationId && state.layer === "single" && state.active === true
    ));
  }, { singleLayer: forceSingleLayer, publicationId: creatorCameraId }, { timeout: 60_000 });

  const receiver = pages[1 === secondPublisherIndex ? 2 : 1];
  await receiver.locator(".nav-item", { hasText: "Live" }).click();
  try {
    await waitForDecodedFrameDelta(receiver, creatorCameraId, "agent", 0, 60_000);
  } catch {
    throw new Error(`agent-routed camera was not rendered: ${JSON.stringify(await mediaDiagnostics())}`);
  }
  const firstFrames = (await decodedFrames(receiver, creatorCameraId, "agent")).frames;
  try {
    await receiver.locator(".remote-audio .audio-label", { hasText: "· Mikrofon" }).waitFor({ timeout: 60_000 });
    await receiver.locator("article.remote-media", { hasText: "· Bildschirm" }).waitFor({ timeout: 60_000 });
  } catch {
    throw new Error(`agent-routed audio or screen was not rendered: ${JSON.stringify(await mediaDiagnostics())}`);
  }
  await receiver.waitForTimeout(8_000);
  const nextFrames = (await decodedFrames(receiver, creatorCameraId, "agent")).frames;
  if (nextFrames <= firstFrames) {
    throw new Error(`agent-routed camera stalled: ${JSON.stringify({
      firstFrames,
      nextFrames,
      diagnostics: await mediaDiagnostics(),
    })}`);
  }

  await pages[1].waitForFunction(() => window.__mediaAgentRoomGate.subscriptionIntents
    .some((intent) => intent.maximumLayer === "low" && intent.enabled === true), null, { timeout: 60_000 });
  await pages[2].waitForFunction(() => window.__mediaAgentRoomGate.subscriptionIntents
    .some((intent) => intent.maximumLayer === "medium" && intent.enabled === true), null, { timeout: 60_000 });
  await pages[3].waitForFunction(() => window.__mediaAgentRoomGate.subscriptionIntents
    .some((intent) => intent.maximumLayer === "high" && intent.enabled === true), null, { timeout: 60_000 });
  await pages[4].waitForFunction(() => window.__mediaAgentRoomGate.subscriptionIntents
    .some((intent) => intent.maximumLayer === "low" && intent.enabled === false), null, { timeout: 60_000 });

  const subscriberPeerIds = await Promise.all(pages.slice(1).map((page) => (
    page.evaluate(() => window.__mediaAgentRoomGate.ownPeerId)
  )));
  try {
    await creator.waitForFunction(({ publications, subscribers, videoEnabled }) => {
      const latest = new Map();
      for (const state of window.__mediaAgentRoomGate.serverSubscriptionStates) {
        latest.set(`${state.publicationId}\0${state.subscriberPeerId}`, state);
      }
      const ready = (publicationId, subscriberPeerId) => (
        latest.get(`${publicationId}\0${subscriberPeerId}`)?.ready === true
      );
      return subscribers.every((peerId) => ready(publications.microphone, peerId))
        && subscribers.every((peerId, index) => (
          videoEnabled[index]
            ? ready(publications.camera, peerId) && ready(publications.screen, peerId)
            : true
        ));
    }, {
      publications: creatorPublications,
      subscribers: subscriberPeerIds,
      videoEnabled: receiveProfiles.slice(1).map((profile) => profile !== "audio-only"),
    }, { timeout: 60_000 });
  } catch {
    const subscriptionSummary = await creator.evaluate(({ publications, subscribers }) => {
      const latest = new Map();
      for (const state of window.__mediaAgentRoomGate.serverSubscriptionStates) {
        latest.set(`${state.publicationId}\0${state.subscriberPeerId}`, state);
      }
      return subscribers.map((peerId, index) => ({
        browser: index + 1,
        camera: latest.get(`${publications.camera}\0${peerId}`) || null,
        microphone: latest.get(`${publications.microphone}\0${peerId}`) || null,
        screen: latest.get(`${publications.screen}\0${peerId}`) || null,
      })).map((entry) => Object.fromEntries(Object.entries(entry).map(([key, value]) => (
        key === "browser" || value === null ? [key, value] : [key, {
          selectedLayer: value.selectedLayer, revision: value.revision, ready: value.ready,
        }]
      ))));
    }, { publications: creatorPublications, subscribers: subscriberPeerIds });
    const inboundSummary = await Promise.all(pages.slice(1).map((page, index) => page.evaluate(async ({
      publications, browser, expectedAgents,
    }) => {
      const route = window.__mediaAgentRoomGate.rawRouteState;
      const ownAssignment = route?.subscriberAssignments?.find((entry) => (
        entry.peerId === window.__mediaAgentRoomGate.ownPeerId
      ));
      const result = {
        browser,
        agentIndex: expectedAgents.indexOf(ownAssignment?.agentId),
        camera: null,
        microphone: null,
        screen: null,
        mediaSections: [...window.__mediaAgentRoomGate.agentSignalSdp],
        receivedMediaSections: [...window.__mediaAgentRoomGate.receivedAgentDescriptions],
        serverErrorCodes: [...window.__mediaAgentRoomGate.serverErrorCodes],
        signalingCloseEvents: [...window.__mediaAgentRoomGate.signalingCloseEvents],
        agentReceivers: [],
        agentDescriptionOperations: [],
        agentTransceivers: [],
        expectedTrackStates: window.__mediaAgentRoomGate.serverTrackStates
          .filter((state) => Object.values(publications).includes(state.publicationId))
          .map((state) => ({
            source: Object.entries(publications).find(([, id]) => id === state.publicationId)?.[0] || "other",
            layer: state.layer,
            active: state.active,
          })),
        expectedIntents: window.__mediaAgentRoomGate.subscriptionIntents
          .filter((intent) => Object.values(publications).includes(intent.publicationId))
          .map((intent) => ({
            source: Object.entries(publications).find(([, id]) => id === intent.publicationId)?.[0] || "other",
            enabled: intent.enabled,
            preferredLayer: intent.preferredLayer,
            maximumLayer: intent.maximumLayer,
          })),
        expectedViews: [...document.querySelectorAll("article.remote-media")]
          .filter((article) => Object.values(publications).includes(article.dataset.publicationId))
          .map((article) => ({
            source: Object.entries(publications).find(([, id]) => id === article.dataset.publicationId)?.[0] || "other",
            transport: article.dataset.transportPeerId?.startsWith("agent:") ? "agent" : "direct",
          })),
      };
      for (const record of window.__mediaAgentRoomGate.peerConnections) {
        if (!record.dataLabels.includes("media-agent-control")) continue;
        result.agentDescriptionOperations.push(...record.descriptionOperations);
        result.agentTransceivers.push(...record.connection.getTransceivers().map((transceiver) => ({
          midAssigned: Boolean(transceiver.mid),
          direction: transceiver.direction,
          currentDirection: transceiver.currentDirection || "none",
          senderTrack: transceiver.sender.track ? "local" : "none",
        })));
        for (const receiver of record.connection.getReceivers()) {
          const source = Object.entries(publications).find(([, publicationId]) => publicationId === receiver.track?.id)?.[0];
          result.agentReceivers.push({
            kind: receiver.track?.kind || "",
            source: source || "other",
            enabled: receiver.track?.enabled,
            readyState: receiver.track?.readyState,
          });
          if (!source) continue;
          const report = await receiver.getStats();
          let bytes = 0;
          let frames = 0;
          report.forEach((value) => {
            if (value.type !== "inbound-rtp") return;
            bytes += value.bytesReceived || 0;
            frames += value.framesDecoded || 0;
          });
          result[source] = { bytes, frames, enabled: receiver.track?.enabled, readyState: receiver.track?.readyState };
        }
      }
      return result;
    }, { publications: creatorPublications, browser: index + 1, expectedAgents: agentIds })));
    throw new Error(`media-agent subscriptions did not converge: ${JSON.stringify({
      subscriptionSummary,
      inboundSummary,
      route: await latestRoute(creator),
      pageErrors,
    })}`);
  }

  if (forceSingleLayer) {
    await creator.waitForFunction(({ publicationId, subscribers }) => {
      const latest = new Map();
      for (const state of window.__mediaAgentRoomGate.serverSubscriptionStates) {
        latest.set(`${state.publicationId}\0${state.subscriberPeerId}`, state);
      }
      return subscribers.every((peerId, index) => index === 3 || (
        latest.get(`${publicationId}\0${peerId}`)?.selectedLayer === "single"
        && latest.get(`${publicationId}\0${peerId}`)?.ready === true
      ));
    }, { publicationId: creatorCameraId, subscribers: subscriberPeerIds }, { timeout: 60_000 });
  }

  const negotiationTurns = await Promise.all(pages.map((page) => page.evaluate(() => ({
    sent: [...window.__mediaAgentRoomGate.agentNegotiationSentTypes],
    received: [...window.__mediaAgentRoomGate.agentNegotiationReceivedTypes],
  }))));
  for (const [index, turn] of negotiationTurns.entries()) {
    assert.ok(turn.received.includes("media-agent-negotiation-request"),
      `browser ${index + 1} did not receive a native negotiation request`);
    assert.ok(turn.sent.includes("media-agent-negotiation-grant"),
      `browser ${index + 1} did not grant a native negotiation turn`);
  }

  const before = await mediaSnapshot(creator);
  await creator.waitForTimeout(5_000);
  const after = await mediaSnapshot(creator);
  const videoDeltas = byteDeltas(before, after, "outboundVideoBytes");
  const agentVideoCopies = videoDeltas.filter((entry) => entry.agent && entry.delta > 1_000).length;
  const directVideoCopies = videoDeltas.filter((entry) => !entry.agent && entry.delta > 1_000).length;
  assert.equal(agentVideoCopies, 1, "publisher must send one active camera/screen copy to its assigned agent");
  if (directVideoCopies !== 0) {
    const sources = await creator.evaluate(() => ({ ...window.__mediaAgentRoomGate.localTrackSources }));
    const perSourceDeltas = after.flatMap((entry) => Object.entries(entry.outboundByTrack).map(([trackId, bytes]) => {
      const earlier = before.find((candidate) => candidate.index === entry.index)?.outboundByTrack[trackId] || 0;
      return { agent: entry.agent, source: sources[trackId] || "unknown", delta: bytes - earlier };
    })).filter(({ delta }) => delta > 0);
    throw new Error(`stable media-agent routing kept direct publisher video fanout: ${JSON.stringify({
      videoDeltas: videoDeltas.map(({ agent, connectionState, delta }) => ({ agent, connectionState, delta })),
      perSourceDeltas,
      subscriptionStates: await creator.evaluate(() => window.__mediaAgentRoomGate.serverSubscriptionStates.map((state) => ({
        source: window.__mediaAgentRoomGate.localTrackSources[state.publicationId] || "remote",
        subscriberIndex: window.__mediaAgentRoomGate.topology.peerIds.indexOf(state.subscriberPeerId),
        selectedLayer: state.selectedLayer,
        revision: state.revision,
        ready: state.ready,
      }))),
      route: await latestRoute(creator),
    })}`);
  }
  const activeAgentConnection = after.find((entry) => entry.agent && entry.connectionState === "connected");
  assert.ok(activeAgentConnection, "publisher has no connected agent PeerConnection");
  if (forceRelay) {
    for (const index of relayBrowserIndexes) {
      const relaySnapshot = await mediaSnapshot(pages[index]);
      const relayConnection = relaySnapshot.find((entry) => entry.agent && entry.connectionState === "connected");
      assert.ok(relayConnection, `relay-only browser ${index + 1} has no connected agent PeerConnection`);
      assert.equal(relayConnection.policy, "relay");
      assert.equal(relayConnection.selectedPair?.localType, "relay");
    }
  } else {
    assert.notEqual(activeAgentConnection.policy, "relay");
    assert.ok(activeAgentConnection.selectedPair);
  }

  await creator.locator("#mesh-analysis-navigation").click();
  await creator.locator(".mesh-edge.media-agent .edge-label").filter({ hasText: /(?:kbit|Mbit)\/s/ }).first().waitFor({ timeout: 30_000 });
  await creator.locator(".mesh-edge.agent-federation").first().waitFor({ timeout: 30_000 });
  await creator.locator(".mesh-node.agent").first().click();
  await creator.locator("#mesh-selected-node", { hasText: "Agent" }).waitFor();
  const agentTraffic = creator.locator(".traffic-detail");
  for (const label of ["Audio", "Kamera / Video", "Bildschirmteilen"]) {
    await agentTraffic.locator("dl > div", { hasText: label }).waitFor();
  }

  let fallbackCopies = 0;
  if (runFaults) {
    const oldPrimary = (await latestRoute(creator)).primaryId;
    await checkpoint(faultMode === "drain" ? "drain-primary"
      : faultMode === "partition" ? "partition-primary" : "stop-primary", oldPrimary);
    await creator.waitForFunction((previous) => {
      const state = window.__mediaAgentRoomGate.routeStates.at(-1);
      return state?.enabled && state.primaryId && state.primaryId !== previous && state.forwarderIds.length === 1;
    }, oldPrimary, { timeout: 90_000 });
    const replacementPrimary = (await latestRoute(creator)).primaryId;
    const beforeFailoverFrames = (await decodedFrames(receiver, creatorCameraId, "agent")).frames;
    try {
      await waitForDecodedFrameDelta(receiver, creatorCameraId, "agent", beforeFailoverFrames, 30_000);
    } catch {
      throw new Error(`camera did not enter replacement-agent route: ${JSON.stringify({
        beforeFailoverFrames,
        diagnostics: await mediaDiagnostics(),
      })}`);
    }
    const recoveredFailoverFrames = (await decodedFrames(receiver, creatorCameraId, "agent")).frames;
    const failoverBeforeStats = {
      sender: await publicationStats(creator, creatorCameraId, "agent", "outbound"),
      receiver: await publicationStats(receiver, creatorCameraId, "agent", "inbound"),
    };
    await receiver.waitForTimeout(8_000);
    const failoverAfterFrames = (await decodedFrames(receiver, creatorCameraId, "agent")).frames;
    if (failoverAfterFrames <= recoveredFailoverFrames) {
      throw new Error(`camera stalled after entering the replacement-agent route: ${JSON.stringify({
        recoveredFailoverFrames,
        failoverAfterFrames,
        before: failoverBeforeStats,
        after: {
          sender: await publicationStats(creator, creatorCameraId, "agent", "outbound"),
          receiver: await publicationStats(receiver, creatorCameraId, "agent", "inbound"),
        },
        diagnostics: await mediaDiagnostics(),
      })}`);
    }

    if (faultMode === "outage") {
      await checkpoint("stop-primary", replacementPrimary);
      await creator.locator("#media-agent-primary", { hasText: "Mesh-Fallback" }).waitFor({ timeout: 90_000 });
      console.log("live gate entered direct mesh fallback");
      await receiver.locator(".nav-item", { hasText: "Live" }).click();
      const fallbackBeforeFrames = (await decodedFrames(receiver, creatorCameraId, "direct")).frames;
      try {
        await waitForDecodedFrameDelta(receiver, creatorCameraId, "direct", fallbackBeforeFrames, 30_000);
      } catch {
        throw new Error(`camera did not enter direct SFrame mesh fallback: ${JSON.stringify({
          fallbackBeforeFrames,
          diagnostics: await mediaDiagnostics(),
        })}`);
      }
      const fallbackRecoveredFrames = (await decodedFrames(receiver, creatorCameraId, "direct")).frames;
      console.log("live gate decoded direct fallback video");
      const fallbackBeforeStats = {
        sender: await publicationStats(creator, creatorCameraId, "direct", "outbound"),
        receiver: await publicationStats(receiver, creatorCameraId, "direct", "inbound"),
      };
      await receiver.waitForTimeout(8_000);
      const fallbackAfterFrames = (await decodedFrames(receiver, creatorCameraId, "direct")).frames;
      if (fallbackAfterFrames <= fallbackRecoveredFrames) {
        throw new Error(`camera stalled after entering direct SFrame mesh fallback: ${JSON.stringify({
          fallbackRecoveredFrames,
          fallbackAfterFrames,
          before: fallbackBeforeStats,
          after: {
            sender: await publicationStats(creator, creatorCameraId, "direct", "outbound"),
            receiver: await publicationStats(receiver, creatorCameraId, "direct", "inbound"),
          },
          diagnostics: await mediaDiagnostics(),
        })}`);
      }
      const fallbackBefore = await mediaSnapshot(creator);
      await creator.waitForTimeout(5_000);
      const fallbackAfter = await mediaSnapshot(creator);
      fallbackCopies = byteDeltas(fallbackBefore, fallbackAfter, "outboundVideoBytes")
        .filter((entry) => !entry.agent && entry.delta > 1_000).length;
      assert.ok(fallbackCopies >= 1, "direct mesh fallback did not carry publisher video");
      await checkpoint("restart-agents", agentIds.join(","));
    } else {
      await checkpoint(faultMode === "drain" ? "restart-drained" : "heal-partition", oldPrimary);
    }
    await waitForRoute(creator, agentIds);
    await creator.locator("#media-agent-primary").filter({ hasNotText: "Mesh-Fallback" }).waitFor({ timeout: 90_000 });
  }

  await creator.locator("#mesh-analysis-navigation").click();
  await creator.locator("#media-agent-consent").uncheck();
  await creator.locator("#media-agent-primary", { hasText: "Mesh-Fallback" }).waitFor({ timeout: 60_000 });
  const leavingPage = pages.at(-1);
  await leavingPage.locator(".nav-item", { hasText: "Live" }).click();
  await leavingPage.locator("#connection-status", { hasText: "Signaling verbunden" }).waitFor({ timeout: 5_000 });
  await leavingPage.evaluate(() => {
    window.__mediaAgentRoomGate.sentControlTypes.length = 0;
    window.__mediaAgentRoomGate.leaveButtonClicks = 0;
    for (const button of document.querySelectorAll("#leave-room")) {
      button.addEventListener("click", () => {
        window.__mediaAgentRoomGate.leaveButtonClicks += 1;
      }, { once: true });
    }
  });
  const visibleLeaveButton = leavingPage.locator("#leave-room:visible");
  assert.equal(await visibleLeaveButton.count(), 1, "expected exactly one visible leave control");
  await visibleLeaveButton.click();
  await leavingPage.waitForFunction(() => (
    window.__mediaAgentRoomGate.sentControlTypes.includes("leave")
  ), undefined, { timeout: 5_000 });
  try {
    await leavingPage.locator("#connection-status", { hasText: "Nicht verbunden" }).waitFor({ timeout: 15_000 });
  } catch {
    const diagnostics = await leavingPage.evaluate(() => ({
      connectionStatus: document.querySelector("#connection-status")?.textContent?.trim().slice(0, 160) || "missing",
      leaveDisabled: document.querySelector("#leave-room")?.disabled ?? null,
      activeNavigation: document.querySelector(".nav-item.active")?.textContent?.trim().slice(0, 80) || "missing",
      signalingCloseEvents: [...window.__mediaAgentRoomGate.signalingCloseEvents],
      leaveButtonClicks: window.__mediaAgentRoomGate.leaveButtonClicks,
      sentControlTypes: window.__mediaAgentRoomGate.sentControlTypes.slice(-8),
      receivedControlTypes: window.__mediaAgentRoomGate.receivedControlTypes.slice(-16),
      welcomeCount: window.__mediaAgentRoomGate.receivedControlTypes.filter((type) => type === "welcome").length,
    }));
    throw new Error(`leaving browser did not publish its disconnected state: ${JSON.stringify({ diagnostics, pageErrors })}`);
  }
  await creator.locator(".nav-item", { hasText: "Live" }).click();
  await creator.locator("#participant-count", { hasText: "5 / 20" }).waitFor({ timeout: 60_000 });

  assert.deepEqual(pageErrors, []);
  console.log(`PASS live media-agent room: scenario=${scenario} fault=${faultMode} browsers=6 agents=2 relayBrowsers=${relayBrowserIndexes.length} layers=${forceSingleLayer ? "single-fallback" : "simulcast-3"} publisherCopies=${agentVideoCopies} directCopies=${directVideoCopies} fallbackCopies=${fallbackCopies}`);
} catch (error) {
  console.error(`FAIL live media-agent room before teardown: ${error instanceof Error ? error.stack : String(error)}`);
  throw error;
} finally {
  await Promise.allSettled([chromiumBrowser.close(), firefoxBrowser.close()]);
}
