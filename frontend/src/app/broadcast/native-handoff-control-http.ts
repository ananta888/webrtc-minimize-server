import { BroadcastBrowserPortError } from "./broadcast-ports";
import { NativePackagerHandoffControl, parseNativeHandoffControl } from "./native-packager-handoff-control";
import type { NativeControlHttpPorts } from "./native-control-http-ports";

export async function requestNativeHandoffControl(programId: string, signal: AbortSignal, ports: NativeControlHttpPorts): Promise<NativePackagerHandoffControl> {
  signal.throwIfAborted();
  const fingerprint = ports.fingerprint();
  if (!/^prg_[A-Za-z0-9_-]{16,64}$/.test(programId) || !fingerprint) throw new BroadcastBrowserPortError("broadcast_active_device_required");
  const response = await fetch(`/api/broadcasts/${encodeURIComponent(programId)}/native-handoff-control`, {
    method: "POST", headers: { "content-type": "application/json", ...ports.authorizationHeader() },
    credentials: "same-origin", redirect: "error", signal,
    body: JSON.stringify({ requestVersion: 1, deviceFingerprint: fingerprint }),
  });
  if (!response.ok) throw ports.responseError(response, "native_handoff_control_failed");
  const value = await ports.readJson(response, "invalid_native_handoff_control", 4096);
  signal.throwIfAborted();
  return parseNativeHandoffControl(value, programId);
}
