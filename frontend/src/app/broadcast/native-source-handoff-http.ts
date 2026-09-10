import { BroadcastBrowserPortError, BroadcastProgramRef } from "./broadcast-ports";
import { NativePackagerHandoffControl, parseNativeHandoffControl } from "./native-packager-handoff-control";

/** Source and legacy callers share the existing closed CAS request, not response semantics. */
export async function requestNativeHandoff(program: BroadcastProgramRef, snapshot: NativePackagerHandoffControl,
  packagerId: string, requestedRenditions: number, allowHardwareAcceleration: boolean, trigger: unknown,
  signal: AbortSignal, fingerprint: string, headers: () => Record<string, string>) {
  signal.throwIfAborted();
  const control = parseNativeHandoffControl(snapshot, program.programId);
  if (trigger !== "user-action" || !/^[A-Za-z0-9_-]{43}$/.test(fingerprint)
    || typeof packagerId !== "string" || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(packagerId)
    || !control.writer || control.writer.packagerId === packagerId || control.programEpoch !== program.programEpoch
    || control.programRevision < program.programRevision || control.handoffPending || !["live", "degraded"].includes(control.state)
    || !Number.isSafeInteger(requestedRenditions) || requestedRenditions < 1 || requestedRenditions > 3
    || typeof allowHardwareAcceleration !== "boolean") throw new BroadcastBrowserPortError("invalid_native_handoff_request");
  const response = await fetch(`/api/broadcasts/${encodeURIComponent(program.programId)}/native-handoffs`, {
    method: "POST", headers: { "content-type": "application/json", ...headers() },
    credentials: "same-origin", redirect: "error", signal,
    body: JSON.stringify({ requestVersion: 1, trigger: "user-action", deviceFingerprint: fingerprint, packagerId,
      expectedProgramRevision: control.programRevision, expectedProgramEpoch: control.programEpoch,
      expectedFencingRevision: control.writer.fencingRevision, requestedRenditions, allowHardwareAcceleration }),
  });
  return { response, control };
}
