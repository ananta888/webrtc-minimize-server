/** Failed private fixture setup only; never return stderr, paths or environment. */
export function nativeCompilerDiagnostic(result) {
  const stderr = typeof result?.stderr === "string" ? result.stderr.slice(0, 65536) : "";
  const code = result?.error?.code;
  const reason = code === "ETIMEDOUT" ? "deadline"
    : code === "ENOBUFS" ? "output_limit"
    : /failed to create new OS thread|fatal error: newosproc|resource temporarily unavailable/i.test(stderr) ? "resource_unavailable"
    : /no space left on device/i.test(stderr) ? "storage_unavailable"
    : /go: .*?(?:download|reading).*?(?:timeout|no such host|connection refused)/i.test(stderr) ? "dependency_unavailable"
    : "unknown";
  return Object.freeze({ phase: "native-source-compile", reason,
    exitCode: Number.isInteger(result?.status) && result.status >= 0 && result.status <= 255 ? result.status : null,
    signal: ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV"].includes(result?.signal) ? result.signal : null });
}
