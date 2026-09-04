import { RuntimeConfig } from "../core/runtime-config.service";
import { BroadcastBrowserPortError } from "./broadcast-ports";
import { WhipRuntimeConfiguration } from "./whip-contracts";

export function whipRuntimeConfiguration(config: RuntimeConfig): WhipRuntimeConfiguration {
  if (!config.broadcast.whip.enabled) throw new BroadcastBrowserPortError("whip-not-configured");
  return Object.freeze({
    configurationVersion: 1,
    compatibilityProfile: config.broadcast.whip.compatibilityProfile,
    endpointUrl: config.broadcast.whip.endpointUrl,
    allowedRedirectOrigins: Object.freeze([...config.broadcast.whip.allowedRedirectOrigins]),
    iceServers: Object.freeze(config.iceServers.map((server) => Object.freeze({ ...server }))),
    codecPreferences: Object.freeze({
      audio: Object.freeze([...config.broadcast.whip.codecPreferences.audio]),
      video: Object.freeze([...config.broadcast.whip.codecPreferences.video]),
    }),
    simulcast: Object.freeze({
      enabled: config.broadcast.whip.simulcast.enabled,
      sendEncodings: Object.freeze(config.broadcast.whip.simulcast.sendEncodings.map(
        (encoding) => Object.freeze({ ...encoding }),
      )),
    }),
    trickleIce: config.broadcast.whip.trickleIce,
    requestTimeoutMs: config.broadcast.whip.requestTimeoutMs,
    iceGatheringTimeoutMs: config.broadcast.whip.iceGatheringTimeoutMs,
    connectionTimeoutMs: config.broadcast.whip.connectionTimeoutMs,
    maximumResponseBytes: config.broadcast.whip.maximumResponseBytes,
    maximumSdpBytes: config.broadcast.whip.maximumSdpBytes,
    maximumIceFragmentBytes: config.broadcast.whip.maximumIceFragmentBytes,
    maximumCandidates: config.broadcast.whip.maximumCandidates,
    retryBudget: config.broadcast.whip.retryBudget,
  });
}
