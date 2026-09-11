import { parsePlaybackCapacity, type PlaybackCapacityScope } from "./playback-capacity";
import type { NativeControlHttpPorts } from "./native-control-http-ports";

export async function requestPlaybackCapacity(scope: PlaybackCapacityScope, additionalSessions: number,
  signal: AbortSignal, ports: NativeControlHttpPorts) {
  signal.throwIfAborted();
  const fingerprint = ports.fingerprint();
  if (!/^prg_[A-Za-z0-9_-]{16,64}$/.test(scope.programId) || !fingerprint
    || !Number.isSafeInteger(additionalSessions) || additionalSessions < 1 || additionalSessions > 10000) {
    throw new Error("invalid_playback_capacity_request");
  }
  const response = await fetch(`/api/broadcasts/${encodeURIComponent(scope.programId)}/playback-capacity`, {
    method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
    headers: { "content-type": "application/json", ...ports.authorizationHeader() },
    body: JSON.stringify({ requestVersion: 1, deviceFingerprint: fingerprint, expectedProgramRevision: scope.programRevision,
      expectedProgramEpoch: scope.programEpoch, additionalSessions }),
  });
  if (!response.ok) throw ports.responseError(response, "playback_capacity_unavailable");
  const value = await ports.readJson(response, "invalid_playback_capacity_response", 2048);
  signal.throwIfAborted();
  return parsePlaybackCapacity(value, scope, additionalSessions);
}
