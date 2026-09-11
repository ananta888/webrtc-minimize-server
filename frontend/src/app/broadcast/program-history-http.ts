import { parseProgramHistory } from "./program-history";
import type { PlaybackCapacityScope } from "./playback-capacity";
import type { NativeControlHttpPorts } from "./native-control-http-ports";
export async function requestProgramHistory(program: PlaybackCapacityScope, signal: AbortSignal, ports: NativeControlHttpPorts) {
  signal.throwIfAborted();
  const fingerprint = ports.fingerprint();
  if (!/^prg_[A-Za-z0-9_-]{16,64}$/.test(program.programId) || !fingerprint) throw new Error("program_history_unavailable");
  const response = await fetch(`/api/broadcasts/${encodeURIComponent(program.programId)}/native-program-history`, {
    method: "POST", headers: { "content-type": "application/json", ...ports.authorizationHeader() },
    credentials: "same-origin", redirect: "error", cache: "no-store", signal,
    body: JSON.stringify({ requestVersion: 2, deviceFingerprint: fingerprint }),
  });
  if (!response.ok) throw ports.responseError(response, "program_history_unavailable");
  const value = await ports.readJson(response, "invalid_program_history_response", 16384);
  signal.throwIfAborted(); return parseProgramHistory(value, program);
}
