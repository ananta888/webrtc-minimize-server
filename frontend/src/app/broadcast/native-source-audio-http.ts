import { BroadcastBrowserPortError, BroadcastProgramRef } from "./broadcast-ports";
import { NativeAudioResult, NativeAudioSelection, parseNativeAudioResult, validAudioSelection } from "./native-source-audio-contract";

import type { NativeControlHttpPorts } from "./native-control-http-ports";

/** Loaded only for native program audio; permissions still belong to the server. */
export async function requestNativeSourceAudio(program: BroadcastProgramRef, selection: NativeAudioSelection | null,
  signal: AbortSignal, ports: NativeControlHttpPorts, version: 1 | 2 | 3 = 1): Promise<NativeAudioResult> {
  signal.throwIfAborted();
  const fingerprint = ports.fingerprint();
  if (!/^prg_[A-Za-z0-9_-]{16,64}$/.test(program.programId) || !fingerprint) {
    throw new BroadcastBrowserPortError("broadcast_active_device_required");
  }
  if (![1, 2, 3].includes(version) || selection !== null && !validAudioSelection(selection, version)) throw new BroadcastBrowserPortError("invalid_native_audio_selection");
  const response = await fetch(`/api/broadcasts/${encodeURIComponent(program.programId)}/native-source-audio`, {
    method: "POST", headers: { "content-type": "application/json", ...ports.authorizationHeader() },
    credentials: "same-origin", cache: "no-store", redirect: "error", signal,
    body: JSON.stringify({ requestVersion: version, deviceFingerprint: fingerprint, expectedProgramRevision: program.programRevision,
      expectedProgramEpoch: program.programEpoch, ...(selection === null ? { action: "query" } : { action: "apply", trigger: "user-action", ...selection }) }),
  });
  if (!response.ok) throw ports.responseError(response, "native_audio_unavailable");
  const value = await ports.readJson(response, "invalid_native_audio_response", 16384);
  signal.throwIfAborted();
  return parseNativeAudioResult(value, program, Date.now(), version);
}
