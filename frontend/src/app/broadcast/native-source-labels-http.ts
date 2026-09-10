import { BroadcastBrowserPortError } from "./broadcast-ports";
import type { NativeSceneState } from "./native-source-scene-contract";
import { NativeSourceLabels, parseNativeSourceLabels } from "./native-source-labels-contract";
import type { NativeControlHttpPorts } from "./native-control-http-ports";

export async function requestNativeSourceLabels(scene: NativeSceneState, signal: AbortSignal, ports: NativeControlHttpPorts): Promise<NativeSourceLabels> {
  signal.throwIfAborted();
  const fingerprint = ports.fingerprint();
  if (!/^prg_[A-Za-z0-9_-]{16,64}$/.test(scene.programId) || !fingerprint) throw new BroadcastBrowserPortError("broadcast_active_device_required");
  const response = await fetch(`/api/broadcasts/${encodeURIComponent(scene.programId)}/native-source-labels`, {
    method: "POST", headers: { "content-type": "application/json", ...ports.authorizationHeader() },
    credentials: "same-origin", cache: "no-store", redirect: "error", signal,
    body: JSON.stringify({ requestVersion: 1, deviceFingerprint: fingerprint, expectedProgramRevision: scene.programRevision,
      expectedProgramEpoch: scene.programEpoch, expectedPackagerId: scene.packagerId, expectedAssignmentId: scene.assignmentId,
      expectedFencingRevision: scene.fencingRevision, sourceLeaseIds: scene.availableSources.map(s => s.sourceLeaseId) }),
  });
  if (!response.ok) throw ports.responseError(response, "native_source_labels_unavailable");
  const value = await ports.readJson(response, "invalid_native_source_labels_response", 16384);
  signal.throwIfAborted();
  return parseNativeSourceLabels(value, scene);
}
