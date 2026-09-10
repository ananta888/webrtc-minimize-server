import { BroadcastBrowserPortError, BroadcastProgramRef } from "./broadcast-ports";
import { NativeSourceAudioOutput, normalizeSourceAudioOutput } from "./native-source-audio-output";
import { NativeSourceVideoOutput, normalizeSourceVideoOutput } from "./native-source-video-output";

interface Ports {
  fingerprint(): string | null;
  authorizationHeader(): Record<string, string>;
}
/** Lazy, bounded source-only start. No implicit capture, consent or legacy ingress. */
export async function requestNativeSourceStart(program: BroadcastProgramRef, packagerId: string,
  requestedRenditions: number, allowHardwareAcceleration: boolean, trigger: unknown, signal: AbortSignal,
  audioOutput: NativeSourceAudioOutput | undefined, ports: Ports, videoOutput?: NativeSourceVideoOutput): Promise<Response> {
  signal.throwIfAborted();
  const output = audioOutput === undefined ? undefined : normalizeSourceAudioOutput(audioOutput);
  const video = videoOutput === undefined ? undefined : normalizeSourceVideoOutput(videoOutput);
  const fingerprint = ports.fingerprint();
  if (trigger !== "user-action" || !/^prg_[A-Za-z0-9_-]{16,64}$/.test(program.programId)
    || !/^pkr_[A-Za-z0-9_-]{16,64}$/.test(packagerId)
    || typeof fingerprint !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(fingerprint)
    || !Number.isSafeInteger(requestedRenditions) || requestedRenditions < 1 || requestedRenditions > 3
    || typeof allowHardwareAcceleration !== "boolean") throw new BroadcastBrowserPortError("invalid_native_source_program_start");
  return fetch(`/api/broadcasts/${encodeURIComponent(program.programId)}/native-source-programs`, {
    method: "POST", headers: { "content-type": "application/json", ...ports.authorizationHeader() },
    credentials: "same-origin", cache: "no-store", redirect: "error", signal,
    body: JSON.stringify({ requestVersion: video ? 3 : output ? 2 : 1, trigger, inputMode: "trusted-sframe-v1", packagerId,
      requestedRenditions, allowHardwareAcceleration, deviceFingerprint: fingerprint,
      ...(video ? { videoOutput: video, audioOutput: output ?? null } : output ? { audioOutput: output } : {}) }),
  });
}
