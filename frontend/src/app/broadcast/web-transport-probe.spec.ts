import { describe, expect, it } from "vitest";

import { createMoqBrowserWebTransportProbe, probeWebTransportAvailability } from "./web-transport-probe";

describe("probeWebTransportAvailability", () => {
  it("does not construct WebTransport and reports only constructor presence", () => {
    const constructed: unknown[] = [];
    class WebTransport { constructor(...args: unknown[]) { constructed.push(args); } }
    expect(probeWebTransportAvailability({ isSecureContext: true, WebTransport })).toEqual({
      available: true, reason: "constructor_present",
    });
    expect(constructed).toEqual([]);
    expect(probeWebTransportAvailability({ isSecureContext: false, WebTransport })).toEqual({
      available: false, reason: "insecure_context",
    });
    expect(probeWebTransportAvailability({ isSecureContext: true })).toEqual({
      available: false, reason: "webtransport_constructor_unavailable",
    });
    expect(createMoqBrowserWebTransportProbe({ isSecureContext: true, WebTransport })).toEqual({
      secureContext: true, webTransportAvailable: true,
    });
    expect(createMoqBrowserWebTransportProbe({ isSecureContext: true })).toEqual({
      secureContext: true, webTransportAvailable: false,
    });
  });
});
