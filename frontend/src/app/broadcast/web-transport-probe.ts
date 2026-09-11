export type WebTransportProbeResult = Readonly<{
  available: boolean;
  reason: "constructor_present" | "insecure_context" | "webtransport_constructor_unavailable";
}>;

export function probeWebTransportAvailability(
  globalObject: Pick<typeof globalThis, "isSecureContext"> & { WebTransport?: unknown } = globalThis,
): WebTransportProbeResult {
  if (globalObject.isSecureContext !== true) {
    return Object.freeze({ available: false, reason: "insecure_context" });
  }
  if (typeof globalObject.WebTransport !== "function") {
    return Object.freeze({ available: false, reason: "webtransport_constructor_unavailable" });
  }
  return Object.freeze({ available: true, reason: "constructor_present" });
}

export function createMoqBrowserWebTransportProbe(
  globalObject: Pick<typeof globalThis, "isSecureContext"> & { WebTransport?: unknown } = globalThis,
): { readonly secureContext: boolean; readonly webTransportAvailable: boolean } {
  const probe = probeWebTransportAvailability(globalObject);
  return Object.freeze({
    secureContext: globalObject.isSecureContext === true,
    webTransportAvailable: probe.available,
  });
}
