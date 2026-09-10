import { BroadcastBrowserPortError, BroadcastProgramRef } from "./broadcast-ports";
import type { NativeControlHttpPorts } from "./native-control-http-ports";

/** Legacy authorized composition ingress; never reinterprets a trusted-source program. */
export async function requestNativePublicationStart(program: BroadcastProgramRef, sourceIds: readonly string[],
  packagerId: string, requestedRenditions: number, signal: AbortSignal,
  ports: Pick<NativeControlHttpPorts, "fingerprint" | "authorizationHeader">): Promise<Response> {
  signal.throwIfAborted();
  const fingerprint = ports.fingerprint();
  if (!/^prg_[A-Za-z0-9_-]{16,64}$/.test(program.programId) || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(packagerId) || !fingerprint
    || !Array.isArray(sourceIds) || sourceIds.length < 1 || sourceIds.length > 4
    || new Set(sourceIds).size !== sourceIds.length || sourceIds.some(id => !/^src_[A-Za-z0-9_-]{16,64}$/.test(id))
    || !Number.isSafeInteger(requestedRenditions) || requestedRenditions < 1 || requestedRenditions > 3) {
    throw new BroadcastBrowserPortError("invalid_native_packager_publication_request");
  }
  return fetch(`/api/broadcasts/${encodeURIComponent(program.programId)}/native-assignments`, {
    method: "POST", headers: { "content-type": "application/json", ...ports.authorizationHeader() },
    credentials: "same-origin", redirect: "error", signal,
    body: JSON.stringify({ requestVersion: 1, trigger: "user-action", packagerId, sourceIds,
      requestedRenditions, allowHardwareAcceleration: true, deviceFingerprint: fingerprint }),
  });
}
