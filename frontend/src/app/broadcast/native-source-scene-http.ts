import { BroadcastBrowserPortError, BroadcastProgramRef } from "./broadcast-ports";
import { NativeSceneResult, NativeSceneSelection, parseNativeSceneResult } from "./native-source-scene-contract";
import type { NativeControlHttpPorts } from "./native-control-http-ports";

export async function requestNativeSourceScene(program: BroadcastProgramRef, selection: NativeSceneSelection | null,
  signal: AbortSignal, ports: NativeControlHttpPorts): Promise<NativeSceneResult> {
  signal.throwIfAborted();
  const fingerprint = ports.fingerprint();
  if (!/^prg_[A-Za-z0-9_-]{16,64}$/.test(program.programId) || !fingerprint) throw new BroadcastBrowserPortError("broadcast_active_device_required");
  const response = await fetch(`/api/broadcasts/${encodeURIComponent(program.programId)}/native-source-scene`, {
    method: "POST", headers: { "content-type": "application/json", ...ports.authorizationHeader() },
    credentials: "same-origin", cache: "no-store", redirect: "error", signal,
    body: JSON.stringify({ requestVersion: selection === null || selection.sourceFits !== undefined ? 2 : 1,
      deviceFingerprint: fingerprint, expectedProgramRevision: program.programRevision, expectedProgramEpoch: program.programEpoch,
      ...(selection === null ? { action: "query" } : { action: "apply", trigger: "user-action", ...selection }) }),
  });
  if (!response.ok) throw ports.responseError(response, "native_scene_unavailable");
  const value = await ports.readJson(response, "invalid_native_scene_response", 16384);
  signal.throwIfAborted();
  return parseNativeSceneResult(value, program);
}
