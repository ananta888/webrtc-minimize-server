// Private, read-only startup probe. No grants, redirects, shared sockets or
// production TLS exceptions. Timers bound a whole request, not socket idleness.
import https from "node:https";

const certificateErrors = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export async function waitMachineTlsReady(origin, ca, {
  get = https.get, clock = () => performance.now(),
  schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  const deadline = clock() + 5000;
  let observation = { phase: "connect", reason: "timeout", attempts: 0 };
  const fail = () => {
    const error = new Error("test_tls_proxy_not_ready");
    error.tlsReadiness = Object.freeze({ ...observation });
    return error;
  };
  for (let attempts = 1; attempts <= 100 && clock() < deadline; attempts++) {
    const result = await new Promise(resolve => {
      let current = true, request, socket, phase = "connect";
      const attemptDeadline = Math.min(deadline, clock() + 300);
      const connected = () => { if (current) phase = "tls"; };
      const secured = () => { if (current) phase = "http"; };
      const onSocket = value => {
        if (!current) return;
        socket = value;
        socket.once("connect", connected);
        socket.once("secureConnect", secured);
      };
      const finish = reason => {
        if (!current) return;
        current = false;
        cancel(timer);
        socket?.off("connect", connected);
        socket?.off("secureConnect", secured);
        request?.off("socket", onSocket);
        request?.destroy();
        resolve({ phase, reason, attempts });
      };
      const timer = schedule(() => finish("timeout"), Math.max(0, attemptDeadline - clock()));
      try {
        request = get(origin + "/healthz", { ca, agent: false, rejectUnauthorized: true }, response => {
          // Headers suffice for readiness; do not retain a response body or a
          // keepalive connection in the proxy's deliberately small socket budget.
          response.on("error", () => {});
          response.destroy();
          if (!current) return;
          phase = "http";
          finish(clock() >= attemptDeadline ? "timeout" : response.statusCode === 200 ? "ready" : "http-status");
        });
        request.on("socket", onSocket);
        request.on("error", error => finish(certificateErrors.has(error?.code) ? "certificate"
          : error?.code === "ECONNREFUSED" ? "refused"
          : error?.code === "ECONNRESET" ? "reset" : "transport"));
      } catch {
        finish("transport");
      }
    });
    observation = result;
    if (result.reason === "ready" && clock() < deadline) return Object.freeze(result);
    if (result.reason === "certificate" || clock() >= deadline) throw fail();
    await new Promise(resolve => schedule(resolve, Math.min(50, deadline - clock())));
  }
  throw fail();
}
